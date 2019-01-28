/* eslint no-console: "off", no-warning-comments: "off", max-depth: "off" */
'use strict'

const debug = require('debug')('peer-base:collaboration:pull-protocol')
const pull = require('pull-stream')
const pushable = require('pull-pushable')
const Queue = require('p-queue')
const handlingData = require('../common/handling-data')
const { encode, decode } = require('delta-crdts-msgpack-codec')
const vectorclock = require('../common/vectorclock')
const expectedNetworkError = require('../common/expected-network-error')

module.exports = class PullProtocol {
  constructor (ipfs, shared, clocks, keys, replication, collaboration, options) {
    this._ipfs = ipfs
    this._shared = shared
    this._clocks = clocks
    this._keys = keys
    this._replication = replication
    this._collaboration = collaboration
    this._options = options
  }

  forPeer (peerInfo) {
    const dbg = (...args) => debug('%s: ' + args[0], this._peerId(), ...args.slice(1))
    const remotePeerId = peerInfo.id.toB58String()
    dbg('pull protocol to %s', remotePeerId)

    const waitTimers = this._waitTimers(dbg)
    const queue = new Queue({ concurrency: 1 })
    let ended = false

    // When the local state is changed, send a clock to the remote peer to let
    // them know
    const onNewLocalClock = (clock) => {
      dbg('local state mutation, new clock:', clock)
      // TODO: only send difference from previous clock
      remote.sendClock(clock)
    }
    this._shared.on('clock changed', onNewLocalClock)

    // Handle incoming message from remote peer
    const messageHandler = (data) => {
      dbg('got new message from %s: %j', remotePeerId, data)

      queue.add(async () => {
        const [deltaRecord, newStates, protocolPeerInfo] = data

        // If the remote peer indicates that it is a pinner, tell it to go into lazy mode
        // Note: The first message sent by push-protocol indicates whether it is a pinner
        if (protocolPeerInfo && protocolPeerInfo.isPinner && !remote.isPinner) {
          dbg('remote peer %s is a pinner, switching to lazy mode', remotePeerId)
          remote.isPinner = true
          remote.setLazyMode()
          return
        }

        // The remote will send us either deltas or the full state
        let clock
        let states
        let delta
        if (deltaRecord) {
          // If we receive deltas, work out what the clock should be
          const [previousClock, authorClock] = deltaRecord
          delta = deltaRecord[2]
          clock = vectorclock.sumAll(previousClock, authorClock)
        } else if (newStates) {
          clock = newStates[0]
          states = newStates[1]
        }

        // If we didn't get a clock, then we can't make any assumptions, so
        // bail out
        if (Object.keys(clock || {}).length === 0) {
          dbg('did not receive clock from %s, bailing out', remotePeerId)
          return
        }

        if (remote.isPinner) {
          // If the remote is a pinner, explicitly set the clock, as we assume
          // pinner clocks are authoritative
          clock = this._clocks.setFor(remotePeerId, clock)
        } else {
          // Otherwise, it may be a full clock or a clock diff. In any case we
          // just merge it into our existing copy of that peer's clock
          clock = this._clocks.mergeFor(remotePeerId, clock)
        }
        dbg('received clock from %s: %j', remotePeerId, clock)

        // If we didn't get any state information, just a clock, then set a
        // timer to wait for the data corresponding to this clock to arrive
        if (!states && !delta) {
          waitTimers.onClock(clock, () => {
            // If the timer expires, switch to eager mode
            dbg('switching to eager mode with peer %s', remotePeerId)
            remote.setEagerMode()
          })
          return
        }

        // If we received states or a delta, the connection is in eager mode.
        // Clear any timers that were waiting for data subsumed by this clock
        waitTimers.onData(clock)
        this._replication.receiving(remotePeerId, clock)

        // Save the state / delta
        let saved
        if (states) {
          dbg('saving states', states)
          const rootState = states.get(null)
          if (!rootState) {
            throw new Error('expected root state')
          }

          const decryptedRootState = await this._decryptAndVerifyDelta(rootState)
          saved = await this._shared.apply(decryptedRootState, false)
          if (saved) {
            for (let [collabName, collabState] of states) {
              if (collabName === null) {
                continue // already processed root state
              }
              await this._shared.apply(await this._decryptAndVerifyDelta(collabState), false, true)
            }
          }
        } else if (delta) {
          dbg('saving delta %j', deltaRecord)
          saved = await this._shared.apply(await this._decryptAndVerifyDelta(deltaRecord), true)
        }

        if (saved) {
          this._replication.received(remotePeerId, clock)
          dbg('saved with new clock %j', saved)
        } else {
          dbg('did not save, setting connection to %s to lazy mode', remotePeerId)
          remote.setLazyMode()
        }
      }).catch(onEnd)
    }

    const onData = (err, data) => {
      if (err) {
        onEnd(err)
        return
      }

      messageHandler(data)
    }

    const onEnd = (err) => {
      if (!ended) {
        if (err && expectedNetworkError(err)) {
          console.warn('%s: pull conn to %s ended with error', this._peerId(), remotePeerId, err.message)
          err = null
        }
        ended = true
        this._shared.removeListener('clock changed', onNewLocalClock)
        this._collaboration.removeListener('stopped', onEnd)
        waitTimers.stop()
        remote.end(err)
      }
    }
    this._collaboration.once('stopped', onEnd)

    const remote = this._remote()
    const input = pull.drain(handlingData(onData), onEnd)

    const vectorClock = this._shared.clock()
    remote.init(vectorClock, this._options.replicateOnly || false)

    return { sink: input, source: remote.output }
  }

  _peerId () {
    if (!this._cachedPeerId) {
      this._cachedPeerId = this._ipfs._peerInfo.id.toB58String()
    }
    return this._cachedPeerId
  }

  _remote () {
    const output = pushable()
    let eager = true

    return {
      output,
      send (msg) {
        // [clock, startLazy, startEager, isLocalPinner]
        output.push(encode(msg))
      },
      sendClock (clock) {
        this.send([clock])
      },
      setLazyMode () {
        if (eager) {
          eager = false
          this.send([null, true])
        }
      },
      setEagerMode () {
        if (!eager) {
          eager = true
          this.send([null, false, true])
        }
      },
      init (clock, isLocalPinner) {
        this.send([clock, null, null, isLocalPinner])
      },
      end (err) {
        output.end(err)
      }
    }
  }

  _waitTimers (dbg) {
    const receiveTimeoutMS = this._options.receiveTimeoutMS
    const timers = new Map()
    let running = true

    const localHasClock = (clock) => {
      const localClock = this._clocks.getFor(this._peerId())
      return vectorclock.doesSecondHaveFirst(clock, localClock)
    }

    return {
      onClock (clock, onTimeout) {
        if (!running) return

        // Check if the remote has information we don't have
        if (localHasClock(clock)) {
          dbg('local already has clock, ignoring')
          return
        }

        // Make sure we aren't already waiting for this clock
        for (const c of timers.keys()) {
          if (vectorclock.doesSecondHaveFirst(clock, c)) {
            dbg('already waiting for data for clock, ignoring')
            return
          }
        }

        dbg('waiting for data for clock %j', clock)
        const timeout = setTimeout(() => {
          // Check if we've received the data for the clock
          if (running && !localHasClock(clock)) {
            dbg('did not receive data within %dms for clock %j', receiveTimeoutMS, clock)
            onTimeout()
          }
        }, receiveTimeoutMS)

        timers.set(clock, timeout)
      },

      onData (clock) {
        if (!running) return

        // Check each timer to see if we've received the corresponding data
        for (const [c, timeout] of timers) {
          if (vectorclock.doesSecondHaveFirst(c, clock)) {
            dbg('received data - clearing timeout for clock %j', c)
            clearTimeout(timeout)
            timers.delete(c)
          }
        }
      },

      stop () {
        dbg('stopping wait timers')
        running = false
        for (const timeout of timers.values()) {
          clearTimeout(timeout)
        }
        timers.clear()
      }
    }
  }

  async _decryptAndVerifyDelta (deltaRecord) {
    const [previousClock, authorClock, [forName, typeName, encryptedDelta]] = deltaRecord
    let decryptedDelta
    if (this._options.replicateOnly) {
      decryptedDelta = encryptedDelta
    } else {
      decryptedDelta = decode(await this._decryptAndVerify(encryptedDelta))
    }
    return [previousClock, authorClock, [forName, typeName, decryptedDelta]]
  }

  _decryptAndVerify (encrypted) {
    const { keys } = this._options
    return new Promise((resolve, reject) => {
      if (!keys.cipher && !keys.read) {
        return resolve(encrypted)
      }
      keys.cipher()
        .then((cipher) => cipher.decrypt(encrypted, (err, decrypted) => {
          if (err) {
            return reject(err)
          }
          const decoded = decode(decrypted)
          const [encoded, signature] = decoded

          keys.read.verify(encoded, signature, (err, valid) => {
            if (err) {
              return reject(err)
            }

            if (!valid) {
              return reject(new Error('delta has invalid signature'))
            }

            resolve(encoded)
          })
        }))
        .catch(reject)
    })
  }
}
