/* eslint no-console: "off" */
'use strict'

const debug = require('debug')('peer-base:collaboration:connection-manager')
const debounce = require('lodash/debounce')
const EventEmitter = require('events')
const PeerSet = require('../common/peer-set')
const Protocol = require('./protocol')

module.exports = class ConnectionManager extends EventEmitter {
  constructor (ipfs, globalConnectionManager, ring, collaboration, shared, clocks, replication, options) {
    super()

    this._ipfs = ipfs
    this._globalConnectionManager = globalConnectionManager
    this._options = options

    if (!this._options.keys) {
      throw new Error('need options.keys')
    }

    this._stopped = true
    this._unreachables = new Map()

    this._ring = ring
    this._ring.on('changed', this._onRingChange.bind(this))

    this._inboundConnections = new PeerSet()
    this._outboundConnections = new PeerSet()
    this._dials = new PeerSet()

    this._protocol = Protocol(ipfs, collaboration, shared, this._options.keys, clocks, replication, options)

    this._protocol.on('inbound connection', (peerInfo) => {
      this._inboundConnections.add(peerInfo)
      this._ring.add(peerInfo)
    })

    this._protocol.on('inbound connection closed', (peerInfo) => {
      this._inboundConnections.delete(peerInfo)
    })

    this._protocol.on('outbound connection', (peerInfo) => {
      this._outboundConnections.add(peerInfo)
    })

    this._protocol.on('outbound connection closed', (peerInfo) => {
      this._outboundConnections.delete(peerInfo)
    })

    this._protocol.on('error', (err) => {
      collaboration.emit('error', err)
    })

    this._debouncedResetConnections = debounce(
      this._resetConnections.bind(this), this._options.debounceResetConnectionsMS)
  }

  start (diasSet) {
    this._stopped = false
    this._diasSet = diasSet

    this._resetInterval = setInterval(() => {
      this._resetConnections()
    }, this._options.resetConnectionIntervalMS)

    return this._globalConnectionManager.handle(this._protocol.name(), this._protocol.handler)
  }

  stop () {
    this._stopped = true
    if (this._resetInterval) {
      clearInterval(this._resetInterval)
      this._resetInterval = null
    }

    this._globalConnectionManager.unhandle(this._protocol.name())

    // disconnects all
    return this._resetConnections()
  }

  observe (observer) {
    const onConnectionChange = () => {
      observer.setInboundPeers(peerIdSetFromPeerSet(this._inboundConnections))
      observer.setOutboundPeers(peerIdSetFromPeerSet(this._outboundConnections))
    }

    this._protocol.on('inbound connection', onConnectionChange)
    this._protocol.on('inbound connection closed', onConnectionChange)
    this._protocol.on('outbound connection', onConnectionChange)
    this._protocol.on('outbound connection closed', onConnectionChange)

    const onInboundMessage = ({ fromPeer, size }) => {
      observer.inboundMessage(fromPeer, size)
    }
    this._protocol.on('inbound message', onInboundMessage)

    const onOutboundMessage = ({ toPeer, size }) => {
      observer.outboundMessage(toPeer, size)
    }
    this._protocol.on('outbound message', onOutboundMessage)

    // return unbind function
    return () => {
      this._protocol.removeListener('inbound connection', onConnectionChange)
      this._protocol.removeListener('inbound connection closed', onConnectionChange)
      this._protocol.removeListener('outbound connection', onConnectionChange)
      this._protocol.removeListener('outbound connection closed', onConnectionChange)
      this._protocol.removeListener('inbound message', onInboundMessage)
      this._protocol.removeListener('outbound message', onOutboundMessage)
    }
  }

  outboundConnectionCount () {
    return this._outboundConnections.size
  }

  outboundConnectedPeers () {
    return Array.from(this._outboundConnections.values()).map(peerInfoToPeerId)
  }

  outboundConnectedPeerInfos () {
    return new PeerSet(this._outboundConnections)
  }

  inboundConnectionCount () {
    return this._inboundConnections.size
  }

  inboundConnectedPeers () {
    return Array.from(this._inboundConnections.values()).map(peerInfoToPeerId)
  }

  vectorClock (peerId) {
    return this._protocol.vectorClock(peerId)
  }

  _onRingChange () {
    this._debouncedResetConnections()
  }

  async _resetConnections () {
    const diasSet = this._stopped ? new PeerSet() : this._diasSet(this._ring)

    // make sure we're connected to every peer of the Dias Peer Set
    const connectPromises = [...diasSet.values()].map(async (peerInfo) => {
      // Check if we already have a connection to the peer
      if (this._outboundConnections.has(peerInfo)) return

      // Check if we're already dialing the peer
      if (this._dials.has(peerInfo)) return

      // Dial the peer
      this._dials.add(peerInfo)
      try {
        const connection = await this._globalConnectionManager.connect(
          peerInfo, this._protocol.name())

        // Check if the dial was cancelled
        if (!this._dials.has(peerInfo)) return

        this._unreachables.delete(peerInfo.id.toB58String())
        this._protocol.dialerFor(peerInfo, connection)
        this.emit('connected', peerInfo)
        connection.once('closed', () => {
          setTimeout(() => {
            this.emit('disconnected', peerInfo)
          }, 0)
        })
      } catch (err) {
        this._peerUnreachable(peerInfo)
        debug('error connecting:', err)
      }
      this._dials.delete(peerInfo)
    })

    // make sure we disconnect from peers not in the Dias Peer Set
    const disconnectPromises = [...this._outboundConnections.values()].map(async (peerInfo) => {
      // Check if we should have a connection to this peer
      if (diasSet.has(peerInfo)) return

      // If not, cancel any pending dial and disconnect
      this._dials.delete(peerInfo)
      try {
        await this._globalConnectionManager.disconnect(peerInfo, this._protocol.name())
      } catch (err) {
        debug('error hanging up:', err)
      }
      this._unreachables.delete(peerInfo.id.toB58String())
    })

    return Promise.all(connectPromises.concat(disconnectPromises))
  }

  _peerUnreachable (peerInfo) {
    const peerId = peerInfo.id.toB58String()
    let count = (this._unreachables.get(peerId) || 0) + 1
    this._unreachables.set(peerId, count)
    if (this._options.maxUnreachableBeforeEviction <= count) {
      this._unreachables.delete(peerId)
      this._ring.remove(peerInfo)
      this.emit('should evict', peerInfo)
    }
  }
}

function peerInfoToPeerId (peerInfo) {
  return peerInfo.id.toB58String()
}

function peerIdSetFromPeerSet (peerSet) {
  return new Set(Array.from(peerSet.values()).map((peerInfo) => peerInfo.id.toB58String()))
}
