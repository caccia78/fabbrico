// Manual end-to-end check: starts the bridge like Claude Code would and calls
// a few tools. Needs Fabbrico open in a browser. Usage: npx tsx bridge/smoke-test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'fabbrico-smoke-test', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'bridge/server.ts'] }));
console.log('instructions:', client.getInstructions()?.slice(0, 80), '…');
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

const show = (r: Awaited<ReturnType<typeof client.callTool>>) =>
  (r.content as { type: string; text?: string; data?: string }[])
    .map((c) => (c.type === 'text' ? c.text!.slice(0, 200) : `[${c.type} ${c.data?.length} b64 chars]`))
    .join(' | ') + (r.isError ? '  (ERROR)' : '');

console.log('get_scene →', show(await client.callTool({ name: 'get_scene', arguments: {} })));
const added = await client.callTool({
  name: 'add_object',
  arguments: { name: 'smoke vase', shape: { kind: 'cylinder', radius: 15, radiusTop: 12, height: 40, segments: 0 },
    modifiers: [{ type: 'displace', pattern: 'ribs', amplitude: 1, period: 6, faces: 'sides', expression: '', resolution: 1 }, { type: 'twist', degrees: 60 }] },
});
console.log('add_object →', show(added));
console.log('bad input →', show(await client.callTool({ name: 'add_object', arguments: { name: 'x', shape: { kind: 'cube' } } })));
console.log('render_view →', show(await client.callTool({ name: 'render_view', arguments: { view: 'iso' } })));
console.log('check_printability →', show(await client.callTool({ name: 'check_printability', arguments: {} })));
await client.close();
