/**
 * Gate delay correctness: the probe sleeps 7000ms inside `tools/pre-execute`.
 *
 * The durable session log must show `tool/call -> (gate held ~7s) -> tool/result`
 * and the tool result must be byte-identical to the gate-0 baseline, i.e. a
 * blocking gate delays execution without corrupting it.
 */
import type { HarnessCase } from '../cases.ts';

export default {
  name: 'gate-7000',
  description: 'Probe gate holds 7000ms in tools/pre-execute; expect the delay visible in the durable log and an intact result.',
  gateMs: 7000,
  task: 'Use the bash tool to run: echo STUB-LLM-OK',
  files: {},
  fake: {
    toolCalls: [{ name: 'bash', arguments: { command: 'echo STUB-LLM-OK', description: 'harness bash call 1' } }],
  },
  expect: {
    exitCode: 0,
    noTimeout: true,
    finalText: { contains: 'FAKE-FINAL' },
    stderr: { notContains: ['TRANSPORT', 'did not activate'] },
    toolResultCount: 1,
    toolResults: [{ equals: 'STUB-LLM-OK\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'call->gate/enter:call_fake_1': [0, 2000],
      'gate/enter->exit:call_fake_1': [6700, 9500],
      'gate/exit->result:call_fake_1': [0, 2000],
      'call->result:call_fake_1': [6700, 11000],
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
      wallMs: [7000, 120000],
    },
  },
} satisfies HarnessCase;
