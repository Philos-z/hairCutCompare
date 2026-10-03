import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const directory = resolve('.cache/certs');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const localIPs = Object.values(networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);
const names = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...localIPs.map(ip => `IP:${ip}`)].join(',');
const caKey = resolve(directory, 'local-ca.key');
const ca = resolve(directory, 'local-ca.pem');
const certificate = resolve(directory, 'server.pem');
const key = resolve(directory, 'server.key');
const run = args => {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? 'OpenSSL 运行失败');
};
try {
  if (!existsSync(ca) || !existsSync(caKey)) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '365', '-sha256', '-subj', '/CN=Hair Compare Local Development CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    run(['x509', '-in', ca, '-outform', 'DER', '-out', resolve(directory, 'local-ca.cer')]);
    chmodSync(caKey, 0o600);
  }
  const previousNames = existsSync(resolve(directory, 'names.txt')) ? readFileSync(resolve(directory, 'names.txt'), 'utf8') : '';
  if (!existsSync(certificate) || !existsSync(key) || previousNames !== names) {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', resolve(directory, 'server.csr'), '-subj', '/CN=localhost']);
    writeFileSync(resolve(directory, 'server.ext'), `subjectAltName=${names}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    run(['x509', '-req', '-in', resolve(directory, 'server.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', certificate, '-days', '365', '-sha256', '-extfile', resolve(directory, 'server.ext')]);
    chmodSync(key, 0o600);
    writeFileSync(resolve(directory, 'names.txt'), names);
  }
  console.log(`本地 HTTPS 证书已准备：${directory}`);
  console.log('在 iPhone 安装并信任 local-ca.cer 后访问：');
  console.log(localIPs.map(ip => `  https://${ip}:5174`).join('\n') || '  https://localhost:5174');
  console.log('证书信任与手机访问步骤见 README.md。此脚本不会安装系统信任。');
  if (!process.argv.includes('--prepare-only')) {
    const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '0.0.0.0'], {
      stdio: 'inherit', env: { ...process.env, HAIR_COMPARE_HTTPS: '1', HAIR_COMPARE_HTTPS_CERT: certificate, HAIR_COMPARE_HTTPS_KEY: key },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
    server.on('exit', code => { process.exitCode = code ?? 0; });
  }
} catch (error) { console.error(`HTTPS 启动失败：${error.message}`); process.exitCode = 1; }
