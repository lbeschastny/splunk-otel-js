/*
 * Copyright Splunk Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  SpanKind,
  Span,
  SpanStatusCode,
  Context,
  propagation,
  Link,
  trace,
  context,
  diag,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import {
  SemanticAttributes,
  MessagingOperationValues,
  MessagingDestinationKindValues,
} from '@opentelemetry/semantic-conventions';
import type * as kafkaJs from 'kafkajs';
import type {
  EachBatchHandler,
  EachMessageHandler,
  Producer,
  RecordMetadata,
  Message,
  ConsumerRunConfig,
  KafkaMessage,
  Consumer,
} from 'kafkajs';
import { KafkaJsInstrumentationConfig } from './types';
import { VERSION } from '../../../version';
import { bufferTextMapGetter } from './propagtor';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  safeExecuteInTheMiddle,
  isWrapped,
} from '@opentelemetry/instrumentation';

export class KafkaJsInstrumentation extends InstrumentationBase<
  typeof kafkaJs
> {
  static readonly component = 'kafkajs';
  protected override _config!: KafkaJsInstrumentationConfig;
  private moduleVersion?: string;

  constructor(config: KafkaJsInstrumentationConfig = {}) {
    super(
      'splunk-opentelemetry-instrumentation-kafkajs',
      VERSION,
      Object.assign({}, config)
    );
  }

  override setConfig(config: KafkaJsInstrumentationConfig = {}) {
    this._config = Object.assign({}, config);
  }

  protected init(): InstrumentationModuleDefinition<typeof kafkaJs> {
    const unpatch: InstrumentationModuleDefinition<
      typeof kafkaJs
    >['unpatch'] = (moduleExports) => {
      diag.debug('kafkajs instrumentation: un-patching');
      if (isWrapped(moduleExports?.Kafka?.prototype.producer)) {
        this._unwrap(moduleExports.Kafka.prototype, 'producer');
      }
      if (isWrapped(moduleExports?.Kafka?.prototype.consumer)) {
        this._unwrap(moduleExports.Kafka.prototype, 'consumer');
      }
    };
    const module: InstrumentationModuleDefinition<typeof kafkaJs> =
      new InstrumentationNodeModuleDefinition<typeof kafkaJs>(
        KafkaJsInstrumentation.component,
        ['*'],
        (moduleExports, moduleVersion) => {
          diag.debug('kafkajs instrumentation: applying patch');
          this.moduleVersion = moduleVersion;

          unpatch(moduleExports);
          this._wrap(
            moduleExports?.Kafka?.prototype,
            'producer',
            this._getProducerPatch()
          );
          this._wrap(
            moduleExports?.Kafka?.prototype,
            'consumer',
            this._getConsumerPatch()
          );

          return moduleExports;
        },
        unpatch
      );
    module.includePrerelease = true;
    return module;
  }

  private _getConsumerPatch() {
    const instrumentation = this;
    return (original: kafkaJs.Kafka['consumer']) => {
      return function consumer(
        this: kafkaJs.Kafka,
        ...args: Parameters<kafkaJs.Kafka['consumer']>
      ) {
        const newConsumer: Consumer = original.apply(this, args);

        if (isWrapped(newConsumer.run)) {
          instrumentation._unwrap(newConsumer, 'run');
        }

        instrumentation._wrap(
          newConsumer,
          'run',
          instrumentation._getConsumerRunPatch()
        );

        return newConsumer;
      };
    };
  }

  private _getProducerPatch() {
    const instrumentation = this;
    return (original: kafkaJs.Kafka['producer']) => {
      return function consumer(
        this: kafkaJs.Kafka,
        ...args: Parameters<kafkaJs.Kafka['producer']>
      ) {
        const newProducer: Producer = original.apply(this, args);

        if (isWrapped(newProducer.sendBatch)) {
          instrumentation._unwrap(newProducer, 'sendBatch');
        }
        instrumentation._wrap(
          newProducer,
          'sendBatch',
          instrumentation._getProducerSendBatchPatch()
        );

        if (isWrapped(newProducer.send)) {
          instrumentation._unwrap(newProducer, 'send');
        }
        instrumentation._wrap(
          newProducer,
          'send',
          instrumentation._getProducerSendPatch()
        );

        return newProducer;
      };
    };
  }

  private _getConsumerRunPatch() {
    const instrumentation = this;
    return (original: Consumer['run']) => {
      return function run(
        this: Consumer,
        ...args: Parameters<Consumer['run']>
      ): ReturnType<Consumer['run']> {
        const config = args[0];
        if (config?.eachMessage) {
          if (isWrapped(config.eachMessage)) {
            instrumentation._unwrap(config, 'eachMessage');
          }
          instrumentation._wrap(
            config,
            'eachMessage',
            instrumentation._getConsumerEachMessagePatch()
          );
        }
        if (config?.eachBatch) {
          if (isWrapped(config.eachBatch)) {
            instrumentation._unwrap(config, 'eachBatch');
          }
          instrumentation._wrap(
            config,
            'eachBatch',
            instrumentation._getConsumerEachBatchPatch()
          );
        }
        return original.call(this, config);
      };
    };
  }

  private _getConsumerEachMessagePatch() {
    const instrumentation = this;
    return (original: ConsumerRunConfig['eachMessage']) => {
      return function eachMessage(
        this: unknown,
        ...args: Parameters<EachMessageHandler>
      ): Promise<void> {
        const payload = args[0];
        const propagatedContext: Context = propagation.extract(
          ROOT_CONTEXT,
          payload.message.headers,
          bufferTextMapGetter
        );
        const span = instrumentation._startConsumerSpan(
          payload.topic,
          payload.message,
          MessagingOperationValues.PROCESS,
          propagatedContext
        );

        const eachMessagePromise = context.with(
          trace.setSpan(propagatedContext, span),
          () => {
            return original!.apply(this, args);
          }
        );
        return instrumentation._endSpansOnPromise([span], eachMessagePromise);
      };
    };
  }

  private _getConsumerEachBatchPatch() {
    return (original: ConsumerRunConfig['eachBatch']) => {
      const instrumentation = this;
      return function eachBatch(
        this: unknown,
        ...args: Parameters<EachBatchHandler>
      ): Promise<void> {
        const payload = args[0];
        // https://github.com/open-telemetry/opentelemetry-specification/blob/master/specification/trace/semantic_conventions/messaging.md#topic-with-multiple-consumers
        const receivingSpan = instrumentation._startConsumerSpan(
          payload.batch.topic,
          undefined,
          MessagingOperationValues.RECEIVE,
          ROOT_CONTEXT
        );
        return context.with(
          trace.setSpan(context.active(), receivingSpan),
          () => {
            const spans = payload.batch.messages.map(
              (message: KafkaMessage) => {
                const propagatedContext: Context = propagation.extract(
                  ROOT_CONTEXT,
                  message.headers,
                  bufferTextMapGetter
                );
                const spanContext = trace
                  .getSpan(propagatedContext)
                  ?.spanContext();
                let origSpanLink: Link | undefined;
                if (spanContext) {
                  origSpanLink = {
                    context: spanContext,
                  };
                }
                return instrumentation._startConsumerSpan(
                  payload.batch.topic,
                  message,
                  MessagingOperationValues.PROCESS,
                  undefined,
                  origSpanLink
                );
              }
            );
            const batchMessagePromise: Promise<void> = original!.apply(
              this,
              args
            );
            spans.unshift(receivingSpan);
            return instrumentation._endSpansOnPromise(
              spans,
              batchMessagePromise
            );
          }
        );
      };
    };
  }

  private _getProducerSendBatchPatch() {
    const instrumentation = this;
    return (original: Producer['sendBatch']) => {
      return function sendBatch(
        this: Producer,
        ...args: Parameters<Producer['sendBatch']>
      ): ReturnType<Producer['sendBatch']> {
        const batch = args[0];
        const messages = batch.topicMessages || [];
        const spans: Span[] = messages
          .map((topicMessage) =>
            topicMessage.messages.map((message) =>
              instrumentation._startProducerSpan(topicMessage.topic, message)
            )
          )
          .reduce((acc, val) => acc.concat(val), []);

        const origSendResult: Promise<RecordMetadata[]> = original.apply(
          this,
          args
        );
        return instrumentation._endSpansOnPromise(spans, origSendResult);
      };
    };
  }

  private _getProducerSendPatch() {
    const instrumentation = this;
    return (original: Producer['send']) => {
      return function send(
        this: Producer,
        ...args: Parameters<Producer['send']>
      ): ReturnType<Producer['send']> {
        const record = args[0];
        const spans: Span[] = record.messages.map((message) => {
          return instrumentation._startProducerSpan(record.topic, message);
        });

        const origSendResult: Promise<RecordMetadata[]> = original.apply(
          this,
          args
        );
        return instrumentation._endSpansOnPromise(spans, origSendResult);
      };
    };
  }

  private _endSpansOnPromise<T>(
    spans: Span[],
    sendPromise: Promise<T>
  ): Promise<T> {
    return Promise.resolve(sendPromise)
      .catch((reason) => {
        let errorMessage: string;
        if (typeof reason === 'string') errorMessage = reason;
        else if (
          typeof reason === 'object' &&
          Object.prototype.hasOwnProperty.call(reason, 'message')
        )
          errorMessage = reason.message;

        spans.forEach((span) =>
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMessage,
          })
        );

        throw reason;
      })
      .finally(() => {
        spans.forEach((span) => span.end());
      });
  }

  private _addModuleVersion(span: Span) {
    if (this._config.moduleVersionAttributeName === undefined) {
      return;
    }

    if (this.moduleVersion === undefined) {
      return;
    }

    span.setAttribute(
      this._config.moduleVersionAttributeName,
      this.moduleVersion
    );
  }

  private _startConsumerSpan(
    topic: string,
    message: KafkaMessage | undefined,
    operation: string,
    context: Context | undefined,
    link?: Link
  ) {
    const span = this.tracer.startSpan(
      topic,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SemanticAttributes.MESSAGING_SYSTEM]: 'kafka',
          [SemanticAttributes.MESSAGING_DESTINATION]: topic,
          [SemanticAttributes.MESSAGING_DESTINATION_KIND]:
            MessagingDestinationKindValues.TOPIC,
          [SemanticAttributes.MESSAGING_OPERATION]: operation,
        },
        links: link ? [link] : [],
      },
      context
    );

    this._addModuleVersion(span);

    if (this._config?.consumerHook && message) {
      safeExecuteInTheMiddle(
        () => this._config.consumerHook!(span, topic, message),
        (e) => {
          if (e) diag.error(`kafkajs instrumentation: consumerHook error`, e);
        },
        true
      );
    }

    return span;
  }

  private _startProducerSpan(topic: string, message: Message) {
    const span = this.tracer.startSpan(topic, {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticAttributes.MESSAGING_SYSTEM]: 'kafka',
        [SemanticAttributes.MESSAGING_DESTINATION]: topic,
        [SemanticAttributes.MESSAGING_DESTINATION_KIND]:
          MessagingDestinationKindValues.TOPIC,
      },
    });

    this._addModuleVersion(span);

    message.headers = message.headers ?? {};
    propagation.inject(trace.setSpan(context.active(), span), message.headers);

    if (this._config?.producerHook) {
      safeExecuteInTheMiddle(
        () => this._config.producerHook!(span, topic, message),
        (e) => {
          if (e) diag.error(`kafkajs instrumentation: producerHook error`, e);
        },
        true
      );
    }

    return span;
  }
}
