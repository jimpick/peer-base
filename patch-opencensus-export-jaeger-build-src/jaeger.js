"use strict";
/**
 * Copyright 2018, OpenCensus Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@opencensus/core");
const os = require("os");
const jaeger_driver_1 = require("./jaeger-driver");
let seq = 0;
/** Format and sends span information to Jaeger */
class JaegerTraceExporter {
    constructor(options) {
        this.queue = [];
        this.successCount = 0;
        /** Manage when the buffer timeout needs to be reseted */
        this.resetTimeout = false;
        /** Indicates when the buffer timeout is running */
        this.timeoutSet = false;
        const pjson = require('../../package.json');
        this.logger = options.logger || core_1.logger.logger();
        this.bufferTimeout = options.bufferTimeout;
        this.bufferSize = options.bufferSize;
        this.sender = new jaeger_driver_1.UDPSender(options);
        const tags = options.tags || [];
        const defaultTags = {};
        defaultTags[JaegerTraceExporter
            .JAEGER_OPENCENSUS_EXPORTER_VERSION_TAG_KEY] =
            `opencensus-exporter-jaeger-${pjson.version}`;
        defaultTags[JaegerTraceExporter.TRACER_HOSTNAME_TAG_KEY] = os.hostname();
        defaultTags[JaegerTraceExporter.PROCESS_IP] = jaeger_driver_1.Utils.ipToInt(jaeger_driver_1.Utils.myIp());
        // Merge the user given tags and the default tags
        const _tags = [...tags, ...jaeger_driver_1.Utils.convertObjectToTags(defaultTags)];
        this.process = {
            serviceName: options.serviceName,
            tags: jaeger_driver_1.ThriftUtils.getThriftTags(_tags),
        };
        this.sender.setProcess(this.process);
    }
    // TODO: should be evaluated if onEndSpan should also return a Promise.
    /**
     * Is called whenever a span is ended.
     * @param root the ended span
     */
    onEndSpan(root) {
        this.logger.debug('onEndSpan: adding rootSpan: %s', root.name);
        // UDPSender buffer is limited by maxPacketSize
        this.addSpanToSenderBuffer(root)
            .then(result => {
            this.addToBuffer(root, result);
            for (const span of root.spans) {
                this.addSpanToSenderBuffer(span)
                    .then(result => {
                    this.addToBuffer(span, result);
                })
                    .catch(err => {
                    return;
                });
            }
        })
            .catch(err => {
            return;
        });
        // Set a buffer timeout
        this.setBufferTimeout();
    }
    /** Not used for this exporter */
    onStartSpan(root) { }
    // add span to local queue, which is limited by bufferSize
    addToBuffer(span, numSpans) {
        // if UDPSender has flushed his own buffer
        if (numSpans > 0) {
            this.successCount += numSpans;
            // if span was not flushed
            if (numSpans === this.queue.length) {
                this.queue = [span];
            }
            else {
                this.queue = [];
            }
        }
        else {
            this.logger.debug('adding to buffer %s', span.name);
            this.queue.push(span);
            if (this.queue.length > this.bufferSize) {
                this.flush();
            }
        }
    }
    // add span to UPDSender buffer
    addSpanToSenderBuffer(span) {
        const thriftSpan = jaeger_driver_1.spanToThrift(span);
        return new Promise((resolve, reject) => {
            // console.log('Jim addSpanToSenderBuffer', thriftSpan)
            this.sender.append(thriftSpan, (numSpans, err) => {
                // console.log('Jim addSpanToSenderBuffer2', numSpans)
                if (err) {
                    this.logger.error(`failed to add span: ${err}`);
                    reject(err);
                }
                else {
                    this.logger.debug('successful append for : %s', numSpans);
                    this.flush()
                    resolve(numSpans);
                }
            });
        });
    }
    /**
     * Publishes a list of root spans to Jaeger.
     * @param rootSpans
     */
    publish(rootSpans) {
        this.logger.debug('JaegerExport publishing');
        for (const root of rootSpans) {
            if (this.queue.indexOf(root) === -1) {
                this.onEndSpan(root);
            }
        }
        return this.flush();
    }
    flush() {
        const mySeq = seq++;
        return new Promise((resolve, reject) => {
            try {
                // console.log('Flushing...', mySeq)
                this.sender.flush((numSpans, err) => {
                    if (err) {
                        // console.log('Flushing failed', mySeq)
                        this.logger.error(`failed to flush span: ${err}`);
                        reject(err);
                    }
                    else {
                        // console.log('Flushing worked', mySeq)
                        this.logger.debug('successful flush for : %s', numSpans);
                        this.successCount += numSpans;
                        this.queue = [];
                        resolve(numSpans);
                    }
                });
            }
            catch (err) {
                this.logger.error(`failed to flush span: ${err}`);
            }
        });
    }
    close() {
        this.sender.close();
    }
    /** Start the buffer timeout, when finished calls flush method */
    setBufferTimeout() {
        this.logger.debug('JaegerExporter: set timeout');
        if (this.timeoutSet) {
            return;
        }
        this.timeoutSet = true;
        setTimeout(() => {
            if (this.queue.length === 0) {
                return;
            }
            this.timeoutSet = false;
            this.flush();
        }, this.bufferTimeout);
    }
}
// Name of the tag used to report client version.
JaegerTraceExporter.JAEGER_OPENCENSUS_EXPORTER_VERSION_TAG_KEY = 'opencensus.exporter.jaeger.version';
// host name of the process.
JaegerTraceExporter.TRACER_HOSTNAME_TAG_KEY = 'opencensus.exporter.jaeger.hostname';
//  ip of the process.
JaegerTraceExporter.PROCESS_IP = 'ip';
exports.JaegerTraceExporter = JaegerTraceExporter;
//# sourceMappingURL=jaeger.js.map
