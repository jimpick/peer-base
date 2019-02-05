const tracing = require('@opencensus/nodejs')
const core = require('@opencensus/core')
const jaeger = require('@opencensus/exporter-jaeger')

const jaegerOptions = {
  serviceName: 'peer-base',
  host: 'localhost',
  port: 6832,
  tags: [{key: 'peer-base', value: '0.0.1'}],
  bufferTimeout: 100, // time in milliseconds
  logger: core.logger.logger('debug'),
  bufferSize: 1,
  maxPacketSize: 9000
};
const exporter = new jaeger.JaegerTraceExporter(jaegerOptions);

tracing.start({
  samplingRate: 1,
  plugins: [],
  exporter
})

const tracer = tracing.tracer

module.exports = { tracer, exporter }
