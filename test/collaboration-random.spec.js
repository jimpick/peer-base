/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const delay = require('delay')
const PeerStar = require('../')
const { registerPrettyClockPeer } = require('../src/collaboration/pretty-clock')
const AppFactory = require('./utils/create-app')

const { tracer, exporter } = require('./utils/tracer')

const debug = require('debug')('peer-base:test:collaboration-random')

const chalk = require('chalk')
describe('collaboration with random changes', function () {
  const unixTime = Date.now()
  const peerCount = 12
  const charsPerPeer = 100
  const timeout = 150 * charsPerPeer * peerCount
  this.timeout(timeout)

  const manyCharacters = (
    'abcdefghijklmnopqrstuvwxyz' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    '1234567890' +
    'ÀÈÌÒÙ' +
    'àèìòù' +
    'ÁÉÍÓÚÝ' +
    'áéíóúý' +
    'ÂÊÎÔÛ' +
    'âêîôû' +
    'ÃÑÕ' +
    'ãñõ' +
    'ÄËÏÖÜŸ' +
    'äëïöüÿ'
  ).split('')

  const collaborationOptions = {}

  let App
  let swarm = []
  let collaborations
  let collaborationIds = new Map()
  let topRootSpan

  before(() => {
    const appName = AppFactory.createName()
    App = AppFactory(appName)
  })

  const peerIndexes = []
  for (let i = 0; i < peerCount; i++) {
    peerIndexes.push(i)
  }

  before(async () => {
    await delay(1000)
    topRootSpan = await makeTopRootSpan(unixTime)
    await Promise.all(peerIndexes.map(async peerIndex => {
      // console.log('Starting', peerIndex)
      const peer = App()
      swarm.push(peer)
      await peer.start()
      peer.id = (await peer.app.ipfs.id()).id
      const peerRootSpan = await makePeerRootSpan(topRootSpan, peer.id, unixTime)
      peer.peerRootSpan = peerRootSpan
      peer.peerRootSpan.end()
    }))
    for (const peerIndex of peerIndexes) {
      const peer = swarm[peerIndex]
      if (peer) {
        registerPrettyClockPeer(peer.id)
      }
    }
    const { traceId } = topRootSpan
    console.log('Trace Id:', traceId)
    console.log('Unix Time:', unixTime)
    // console.log(`http://localhost:16686/trace/${traceId}`)
    console.log(`https://jaeger.jimpick.com/trace/${traceId}`)
    topRootSpan.end()
  })

  after(() => Promise.all(peerIndexes.map(async peerIndex => {
    const peer = swarm[peerIndex]
    if (peer) {
      await peer.stop()
      // peer.peerRootSpan.end()
    }
  })))

  after(async () => {
    await delay(5000)
    /*
    console.log('Draining jaeger queue...')
    for (let i = 0; i < 10; i++) {
      console.log(exporter.queue.length)
      await delay(1000)
    }
    console.log(exporter.queue.length)
    */
  })

  before(async () => {
    collaborationOptions.keys = await PeerStar.keys.generate()
    await delay(1000)
  })

  it('can be created', async () => {
    collaborations = await Promise.all(
      swarm.map((peer) => peer.app.collaborate(
        'test random collaboration',
        'rga',
        {
          ...collaborationOptions,
          tracer,
          makeRootSpan: getMakeRootSpan(peer.peerRootSpan, peer.id, unixTime)
        }
      ))
    )
    expect(collaborations.length).to.equal(peerCount)
    await Promise.all(collaborations.map(async c => {
      const id = (await c.app.ipfs.id()).id
      collaborationIds.set(c, id)
      // c._options.tracingSpan.addAttribute('id', id)
    }))
    // await waitForMembers(collaborations)
  })

  it('handles random changes', async () => {
    console.log('Now:', (new Date()).toLocaleString())
    console.log(`Timeout in: ${Math.floor(timeout / 1000)}s`)
    console.log('Timeout at:', (new Date(Date.now() + timeout)).toLocaleString())

    const expectedCharacterCount = charsPerPeer * collaborations.length

    const waitForHalfModifications = () => Promise.all(collaborations.map((collaboration) => new Promise((resolve) => {
      const expectedCount = Math.round(expectedCharacterCount / 2)
      const currentCount = collaboration.shared.value().length

      if (currentCount >= expectedCount) {
        return resolve()
      }

      const onStateChanged = () => {
        const currentCount = collaboration.shared.value().length
        if (currentCount >= expectedCount) {
          collaboration.removeListener('state changed', onStateChanged)
          resolve()
        }
      }

      collaboration.on('state changed', onStateChanged)
    })))

    const modifications = async (collaboration, i) => {
      const waitForCharCount = new Promise((resolve) => {
        debug(`Waiting1 ${collaborationIds.get(collaboration).slice(-3)} ` +
              `${collaboration.shared.value().length}`)

        if (collaboration.shared.value().length === expectedCharacterCount) {
          return resolve()
        }
        collaboration.on('state changed', () => {
          debug(`Waiting2 ${collaborationIds.get(collaboration).slice(-3)} ` +
                `${collaboration.shared.value().length}`)

          const value = collaboration.shared.value()
          const currentCount = value.length
          if (currentCount === expectedCharacterCount) {
            resolve()
          }
        })
      })

      for (let j = 0; j < charsPerPeer; j++) {
        const character = characterFrom(manyCharacters, i * charsPerPeer + j)
        debug(chalk.green(
          `Push ${collaborationIds.get(collaboration).slice(-3)} ${j + 1} "${character}"`
        ))
        collaboration.shared.push(character)
        if (i === Math.round(charsPerPeer / 2)) {
          await waitForHalfModifications()
        } else {
          await delay(randomShortTime())
        }
      }

      return waitForCharCount.then(async () => {
        debug('got state changes for', collaborationIds.get(collaboration))
      })
    }

    // Wait for all the state changes to come in
    debug('waiting for state changes')

    await Promise.all(collaborations.map(modifications))
    debug('got all state changes')

    // The length of all collaborations should be the expected length
    for (let i = 0; i < collaborations.length; i++) {
      expect(collaborations[i].shared.value().length).to.equal(expectedCharacterCount)
    }

    // The value of all collaborations should be the same
    const expectedValue = collaborations[0].shared.value()
    for (const c of collaborations) {
      expect(c.shared.value()).to.eql(expectedValue)
    }

    // validate all vector clocks are correct
    for (let collaboration of collaborations) {
      const peerId = collaborationIds.get(collaboration)
      const clocks = collaboration.vectorClock(peerId)
      expect(Object.keys(clocks).length).to.equal(peerCount)
      for (let clock of Object.values(clocks)) {
        expect(clock).to.equal(charsPerPeer)
      }
    }

    function randomShortTime () {
      return Math.floor((1 / Math.log(Math.random() * 5 + 1.015) * 20) + 10)
    }

    function characterFrom (characters, index) {
      return characters[index % characters.length]
    }

  })
})

async function makeTopRootSpan (unixTime) {
  const promise = new Promise(resolve => {
    tracer.startRootSpan({ name: 'collaboration-random' }, resolve)
  })
  const rootSpan = await promise
  rootSpan.addAttribute('unixTime', `${unixTime}`)
  rootSpan.start()
  return rootSpan
}

async function makePeerRootSpan (topRootSpan, id, unixTime) {
  const spanContext = topRootSpan.spanContext
  const promise = new Promise(resolve => {
    tracer.startRootSpan({
      name: 'peer ' + id.slice(-3),
      spanContext
    }, resolve)
  })
  const rootSpan = await promise
  rootSpan.addAttribute('unixTime', `${unixTime}`)
  rootSpan.addAttribute('peer', `${id}`)
  rootSpan.start()
  return rootSpan
}

function getMakeRootSpan (peerRootSpan, id, unixTime) {
  const spanContext = peerRootSpan.spanContext
  const makeRootSpan = name => {
    const promise = new Promise(resolve => {
      tracer.startRootSpan({ name, spanContext }, resolve)
    })
    .then(rootSpan => {
      rootSpan.addAttribute('unixTime', `${unixTime}`)
      rootSpan.addAttribute('peer', `${id}`)
      return rootSpan
    })
    return promise
  }
  return makeRootSpan
}
