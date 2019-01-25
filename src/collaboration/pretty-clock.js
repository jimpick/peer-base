const peerToClockId = require('./peer-to-clock-id')

const peers = [
  'QmdXPocZdyJyzXTCc5Z8Mfw35KV1ezC1St8es8UDYKMums',
  'QmcnJwXLUE27YpyPR7GwRF8h6o1ouR6iBkcTUk9sShXS8c',
  'QmYhezh22kguEdAHB6uqQKLFmT13K46oonvn3jFwCiyumQ'
]
const peerClock = peers.map(peer => [
  peerToClockId(peer),
  peer.slice(-3)
])

module.exports = clock => {
  const clocks = peerClock.reduce(
    (acc, [clockId, name]) => {
      if (clock[clockId] >= 0) {
        acc.push(`${name}:${clock[clockId]}`)
      }
      return acc
    },
    []
  )
  return '[' + clocks.join(' ') + ']'
}
