/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const delay = require('delay')
const PeerStar = require('../')
const AppFactory = require('./utils/create-app')

const tracer = require('./utils/tracer')

const debug = require('debug')('peer-base:test:collaboration-random')

const chalk = require('chalk')
describe('collaboration with random changes', function () {
  const peerCount = process.browser ? 10 : 2
  // const peerCount = process.browser ? 10 : 10
  const charsPerPeer = 5
  // const charsPerPeer = 200
  this.timeout(2000000 * peerCount)

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
  let rootSpans = []

  before(() => {
    const appName = AppFactory.createName()
    App = AppFactory(appName)
  })

  const peerIndexes = []
  for (let i = 0; i < peerCount; i++) {
    peerIndexes.push(i)
  }

  before(() => Promise.all(peerIndexes.map(async peerIndex => {
    rootSpans[peerIndex] = await startRootSpan(peerIndex)
    const app = App()
    swarm.push(app)
    return app.start()
  })))

  after(() => Promise.all(peerIndexes.map(async (peerIndex) => {
    if (swarm[peerIndex]) {
      const promise = swarm[peerIndex].stop().then(() => {
        const promise = new Promise(resolve => {
          rootSpans[peerIndex].end()
          setTimeout(resolve, 4000)
        })
        return promise
      })
      return promise
    }
  })))

  before(async () => {
    collaborationOptions.keys = await PeerStar.keys.generate()
  })

  it('can be created', async () => {
    collaborations = await Promise.all(
      swarm.map((peer) => peer.app.collaborate('test random collaboration', 'rga', collaborationOptions)))
    expect(collaborations.length).to.equal(peerCount)
    await Promise.all(collaborations.map(async c => {
      const id = (await c.app.ipfs.id()).id
      collaborationIds.set(c, id)
    }))
    // await waitForMembers(collaborations)
  })

  it('handles random changes', async () => {
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

function startRootSpan (peerIndex) {
  const promise = new Promise(resolve => {
    setTimeout(() => {
      tracer.startRootSpan({
        name: 'peer'
      }, resolve)
    }, 1000)
  })
  .then(rootSpan => {
    rootSpan.addAttribute('peerIndex', peerIndex)
    return rootSpan
  })
  return promise
}