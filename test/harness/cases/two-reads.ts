/**
 * One assistant message carrying TWO tool calls, both safe reads.
 *
 * DSH dispatches same-step calls concurrently, but the waterfall gate is awaited
 * per call, so a 2000ms gate serialises them: the second `gate/enter` only
 * happens after the first `gate/exit` (gateSpanMs ~= 2 x gateMs, not ~1 x).
 * That degradation is accepted by the design (the gate promise resolves once and
 * everything is released afterwards), but it must stay visible in the numbers.
 *
 * `{{WS}}` is substituted with this run's absolute workspace directory.
 */
import type { HarnessCase } from '../cases.ts';

export default {
  name: 'two-reads',
  description: 'Two concurrent reads in one message under a 2000ms gate; expect serialised gate holds and both files returned.',
  gateMs: 2000,
  task: 'Read ws/a.txt and ws/b.txt with the read tool.',
  files: {
    'a.txt': 'alpha\n',
    'b.txt': 'beta\n',
  },
  fake: {
    toolCalls: [
      { name: 'read', arguments: { file_path: '{{WS}}/a.txt' } },
      { name: 'read', arguments: { file_path: '{{WS}}/b.txt' } },
    ],
  },
  expect: {
    exitCode: 0,
    noTimeout: true,
    finalText: { contains: 'FAKE-FINAL' },
    stderr: { notContains: ['TRANSPORT', 'did not activate'] },
    toolResultCount: 2,
    toolResults: [
      { callId: 'call_fake_1', isError: false, contains: 'alpha' },
      { callId: 'call_fake_2', isError: false, contains: 'beta' },
    ],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 2,
      toolResults: 2,
      'gate/enter->exit:call_fake_1': [1700, 3000],
      'gate/enter->exit:call_fake_2': [1700, 3000],
      gateSpanMs: [3700, 6500], // 2 x 2000ms serialised, plus slack
      'fake.requests': 3, // opening tool request + racing title request + closing text request
      'fake.titleRoute': 1,
      'fake.toolRouteAttempts': 1,
      'fake.closingRoute': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
