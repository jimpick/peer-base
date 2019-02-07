const fs = require('fs')

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n')

async function run () {
  let testNum
  let traceId
  let pass
  console.log('| Run | Pass/Fail | Duration | Spans | Failure Mode ' + 
              '| Jaeger Link |')
  console.log('| --- | ---       | ---      | ---   | ---          ' +
              '| ---         |')
  for (const line of lines) {
    let match
    match = line.match(/^Test Run (\d+) of (\d+)$/)
    if (match) {
      testNum = Number(match[1])
      // console.log('testNum', testNum)
    }
    match = line.match(/^Trace Id: (.*)$/)
    if (match) {
      traceId = match[1]
      // console.log('traceId', traceId)
    }
    match = line.match(/2 passing/)
    if (match) {
      pass = true
    }
    match = line.match(/^Done\.$/)
    if (match) {
      // console.log('Emit:', testNum, traceId, pass)
      console.log(
        `| ${testNum} | ${pass ? 'Pass' : 'Fail'} ` +
        `| ?s     | ?  |  | ` +
        `[${traceId.slice(0, 7)}](https://jaeger.jimpick.com/trace/${traceId}) |`
      )
      testNum = undefined
      traceId = undefined
      pass = undefined
    }
    // console.log('Jim', line)
  }
}

run()
