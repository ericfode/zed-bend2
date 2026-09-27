// Keep this bootstrap compatible with older Node releases: check the runtime
// before importing the Node 22-targeted server or any of its dependencies.
const version = process.versions.node;
const major = Number(version.split('.')[0]);

if (!Number.isInteger(major) || major < 22) {
  console.error(
    `Bend2 requires Node.js 22 or newer; Zed's Node.js runtime reported ${version}. `
    + 'Configure Zed to use Node.js 22+ or set lsp.bend2.binary.path to a custom language server.',
  );
  process.exitCode = 1;
} else {
  import('./server.mjs').catch(error => {
    console.error('Could not start the Bend2 language server:', error);
    process.exitCode = 1;
  });
}
