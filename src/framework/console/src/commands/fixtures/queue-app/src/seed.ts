// Puts one message on the fixture's queue, from a process of its own — which is the point:
// `queue:work` runs in a different one, and the store has to survive the gap.
import { queues, SendReceipt } from './app.ts';

const payload = JSON.parse(process.argv[2] ?? '{"orderId":"o-1"}') as {
  orderId: string;
  fail?: boolean;
};
const result = await queues.connection().dispatch(SendReceipt, payload);
process.stdout.write(`${result.id}\n`);
