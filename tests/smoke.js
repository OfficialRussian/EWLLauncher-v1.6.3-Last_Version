'use strict';
// Запуск: node tests/smoke.js  (без Electron и без интернета)
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewl-'));
process.env.EWL_DATA_DIR = path.join(tmp, 'data');
process.env.EWL_GAME_DIR = path.join(tmp, 'game');

const src = (p) => require(path.join(__dirname, '..', 'src', 'main', p));
let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
};

(async () => {
  await t('offline uuid совпадает с Minecraft', () => {
    const o = src('accounts/offline');
    assert.strictEqual(o.offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
    assert.throws(() => o.validateName('a'));
    assert.throws(() => o.validateName('имя'));
  });

  await t('rules: allow/disallow', () => {
    const r = src('minecraft/rules');
    const ctx = r.currentContext({ platform: 'windows', arch: 'x64' });
    assert.ok(r.isAllowed(undefined, ctx));
    assert.ok(!r.isAllowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], ctx));
    assert.ok(r.isAllowed([{ action: 'allow', os: { name: 'windows' } }], ctx));
    assert.ok(!r.isAllowed([{ action: 'allow', os: { name: 'osx' } }], ctx));
  });

  await t('splitArgs/fill', () => {
    const l = src('minecraft/launch');
    assert.deepStrictEqual(l.splitArgs('-Da="x y" -Xmx1G'), ['-Da=x y', '-Xmx1G']);
    assert.strictEqual(l.fill('${a}-${b}-${zz}', { a: 1, b: 2 }), '1-2-${zz}');
  });

  await t('buildArguments (новый и старый формат)', () => {
    const l = src('minecraft/launch');
    const ctx = src('minecraft/rules').currentContext({ platform: 'windows', arch: 'x64' });
    const settings = { ramMax: 2048, ramMin: 512, jvmArgs: '-XX:+UseG1GC', width: 854, height: 480, fullscreen: false };
    const vars = { classpath: 'a.jar', natives_directory: 'n', auth_player_name: 'Steve' };
    const modern = l.buildArguments({
      v: { mainClass: 'M', arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] } },
      vars, ctx, settings, quickPlay: { host: '1.2.3.4', port: 25565 },
    });
    assert.deepStrictEqual(modern.slice(0, 2), ['-Xmx2048M', '-Xms512M']);
    assert.ok(modern.includes('M') && modern.includes('Steve'));
    assert.ok(modern.join(' ').includes('--server 1.2.3.4 --port 25565'));
    const legacy = l.buildArguments({ v: { mainClass: 'M', minecraftArguments: '--username ${auth_player_name}' }, vars, ctx, settings, quickPlay: null });
    assert.ok(legacy.includes('-Djava.library.path=n') && legacy.includes('a.jar'));
  });

  await t('maven path и collectLibraries', () => {
    const i = src('minecraft/install');
    assert.strictEqual(i.mavenPath('net.fabricmc:fabric-loader:0.15.0'), 'net/fabricmc/fabric-loader/0.15.0/fabric-loader-0.15.0.jar');
    const r = i.collectLibraries(tmp, { libraries: [
      { name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', url: 'http://x/b.jar', sha1: 'x', size: 1 } } },
      { name: 'c:d:1', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'c/d.jar', url: 'u' } } },
    ] }, src('minecraft/rules').currentContext({ platform: 'windows', arch: 'x64' }));
    assert.strictEqual(r.classpath.length, 1);
  });

  await t('settings: нормализация и сохранение', () => {
    const { Settings } = src('settings/settings');
    const s = new Settings();
    s.load();
    const u = s.update({ ramMax: 99999999, width: 5, jvmArgs: 'a\nb', server: { port: 80, motd: 'x\ny' }, msClientId: 'bad id!' });
    assert.ok(u.ramMax <= Math.max(2048, Math.floor(os.totalmem() / 1048576)));
    assert.strictEqual(u.width, 320);
    assert.ok(!u.jvmArgs.includes('\n'));
    assert.strictEqual(u.server.port, 1024);
    assert.strictEqual(u.msClientId, '');
    const s2 = new Settings();
    assert.strictEqual(s2.load().width, 320);
  });

  await t('accounts: офлайн, выбор, удаление', () => {
    const { AccountService } = src('accounts/accounts');
    const a = new AccountService(path.join(tmp, 'acc.json')).load();
    const x = a.addOffline('Steve');
    assert.strictEqual(a.addOffline('steve').id, x.id);
    a.addOffline('Alex');
    assert.strictEqual(a.list().length, 2);
    const b = new AccountService(path.join(tmp, 'acc.json')).load();
    assert.strictEqual(b.list().length, 2);
    assert.ok(!JSON.stringify(b.list()).includes('Token'));
    b.remove(x.id);
    assert.strictEqual(b.list().length, 1);
  });

  await t('secrets: round-trip', () => {
    const s = src('core/secrets');
    assert.strictEqual(s.unprotect(s.protect('tok123')), 'tok123');
  });

  await t('paths: защита от traversal', () => {
    const p = src('core/paths');
    assert.throws(() => p.assertSafeId('../evil'));
    assert.throws(() => p.assertSafeId('a/b'));
    assert.ok(p.assertSafeId('1.21.1'));
  });

  await t('invite: encode/decode, подделка, срок', () => {
    const inv = src('multiplayer/invite');
    const code = inv.encode({ addrs: [{ host: '203.0.113.5', port: 25565 }, { host: '2001:db8::1', port: 25565 }], name: 'Steve', version: '1.21.1', expiresAt: Date.now() + 60000 });
    const d = inv.decode(code);
    assert.strictEqual(d.addrs.length, 2);
    assert.strictEqual(d.version, '1.21.1');
    assert.ok(!d.expired);
    assert.ok(inv.decode(code, Date.now() + 120000).expired);
    assert.throws(() => inv.decode('hello'), /EWL1/);
    assert.throws(() => inv.decode(code.slice(0, -4)));
    const tampered = code.slice(0, 12) + (code[12] === 'A' ? 'B' : 'A') + code.slice(13);
    assert.throws(() => inv.decode(tampered));
  });

  await t('netinfo: приватные/CGNAT/IPv6', () => {
    const n = src('multiplayer/netinfo');
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '127.0.0.1', '100.64.1.1', '169.254.1.1']) assert.ok(n.isNonPublicV4(ip), ip);
    assert.ok(!n.isNonPublicV4('8.8.8.8'));
    assert.ok(n.isCgnatV4('100.100.0.1'));
    assert.ok(n.isGlobalV6('2001:db8::1') && !n.isGlobalV6('fe80::1') && !n.isGlobalV6('fd00::1') && !n.isGlobalV6('::1'));
    assert.ok(n.isPublicAddress('8.8.8.8') && !n.isPublicAddress('192.168.0.5'));
  });

  await t('stun: разбор XOR-MAPPED-ADDRESS', () => {
    const st = src('multiplayer/stun');
    const req = st.buildRequest();
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0); res.writeUInt16BE(12, 2); res.writeUInt32BE(0x2112a442, 4);
    req.copy(res, 8, 8, 20);
    res.writeUInt16BE(0x0020, 20); res.writeUInt16BE(8, 22); res[25] = 1;
    res.writeUInt16BE(54321 ^ 0x2112, 26);
    [203, 0, 113, 7].forEach((b, i) => { res[28 + i] = b ^ [0x21, 0x12, 0xa4, 0x42][i]; });
    assert.deepStrictEqual(st.parseResponse(res, req.subarray(8, 20)), { ip: '203.0.113.7', port: 54321 });
  });

  await t('upnp: разбор описания устройства', () => {
    const u = src('multiplayer/upnp');
    const xml = '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>';
    const s = u.parseServices(xml, 'http://192.168.1.1:5000/rootDesc.xml');
    assert.strictEqual(s[0].controlUrl, 'http://192.168.1.1:5000/ctl/IPConn');
  });

  await t('server.properties: обновление', () => {
    const { updateProps } = src('multiplayer/server');
    const out = updateProps('# c\nserver-port=1\nfoo=bar\n', { 'server-port': 25570, 'white-list': true });
    assert.ok(out.includes('server-port=25570') && out.includes('foo=bar') && out.includes('white-list=true') && out.includes('# c'));
  });

  await t('probe: фейковый Minecraft-сервер + join.inspect', async () => {
    const { writeVarInt, readVarInt, probe } = src('multiplayer/probe');
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        const l1 = readVarInt(buf);
        if (!l1 || buf.length < l1.size + l1.value) return;
        const rest = buf.subarray(l1.size + l1.value);
        if (rest.length >= 2 && !sock.sentStatus) {
          sock.sentStatus = true;
          const json = Buffer.from(JSON.stringify({ version: { name: '1.21.1', protocol: 767 }, players: { online: 1, max: 8 }, description: { text: 'Hi', extra: [{ text: '!' }] } }));
          const body = Buffer.concat([writeVarInt(0), writeVarInt(json.length), json]);
          sock.write(Buffer.concat([writeVarInt(body.length), body]));
        } else if (sock.sentStatus && rest.length > 2 && !sock.pong) {
          sock.pong = true;
          const body = Buffer.concat([writeVarInt(1), Buffer.alloc(8)]);
          sock.write(Buffer.concat([writeVarInt(body.length), body]));
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const r = await probe('127.0.0.1', port, { timeoutMs: 3000 });
    assert.strictEqual(r.version, '1.21.1');
    assert.strictEqual(r.players.max, 8);
    assert.strictEqual(r.motd, 'Hi!');
    const { inspectInvite } = src('multiplayer/join');
    const inv = src('multiplayer/invite');
    const code = inv.encode({ addrs: [{ host: '127.0.0.1', port }], name: 'A', version: '1.21.1', expiresAt: Date.now() + 5000 });
    await assert.rejects(inspectInvite(code), /локальные/);
    const res = await inspectInvite(code, { allowLocal: true });
    assert.ok(res.best && res.best.ok);
    await new Promise((r2) => server.close(r2));
    await assert.rejects(probe('127.0.0.1', port, { timeoutMs: 1500 }));
  });

  await t('java: разбор версии', () => {
    const j = src('minecraft/java');
    assert.strictEqual(j.parseJavaMajor('java version "1.8.0_341"'), 8);
    assert.strictEqual(j.parseJavaMajor('openjdk version "17.0.5" 2022'), 17);
    assert.strictEqual(j.parseJavaMajor('openjdk version "21" 2023'), 21);
  });

  await t('http.downloadFile: sha1, размер, отмена', async () => {
    const http = src('core/http');
    const crypto = require('crypto');
    const body = Buffer.from('hello ewl');
    const sha = crypto.createHash('sha1').update(body).digest('hex');
    const srv = require('http').createServer((q, s) => { s.end(body); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    const dest = path.join(tmp, 'dl', 'f.bin');
    await http.downloadFile(url, dest, { sha1: sha, size: body.length });
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello ewl');
    await assert.rejects(http.downloadFile(url, path.join(tmp, 'dl', 'bad'), { sha1: '0'.repeat(40) }), /Контрольная/);
    assert.ok(!fs.existsSync(path.join(tmp, 'dl', 'bad')));
    srv.close();
  });

  await t('install.downloadAll: битый файл того же размера перекачивается (strict)', async () => {
    const crypto = require('crypto');
    const { downloadAll } = src('minecraft/install');
    const body = crypto.randomBytes(300000);
    const sha = crypto.createHash('sha1').update(body).digest('hex');
    const srv = require('http').createServer((q, s) => s.end(body));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    const dest = path.join(tmp, 'strict', 'lib.jar');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const broken = Buffer.from(body); broken[1000] ^= 0xff; // тот же размер, другое содержимое
    fs.writeFileSync(dest, broken);
    const task = [{ url, dest, sha1: sha, size: body.length }];
    const noop = () => {};
    await downloadAll(task, { label: 'x', range: [0, 1], onProgress: noop, strict: false });
    assert.ok(fs.readFileSync(dest).equals(broken), 'без strict файл считается целым (поведение по размеру)');
    await downloadAll(task, { label: 'x', range: [0, 1], onProgress: noop, strict: true });
    assert.ok(fs.readFileSync(dest).equals(body), 'strict должен заменить битый файл');
    srv.close();
  });

  await t('loaders: сравнение версий и выбор стабильной', () => {
    const L = src('minecraft/loaders');
    const list = ['0.20.0-beta.9', '0.27.1', '0.9.0', '0.27.0-beta.2'].sort((a, b) => L.compareVersions(b, a));
    assert.deepStrictEqual(list, ['0.27.1', '0.27.0-beta.2', '0.20.0-beta.9', '0.9.0']);
    assert.ok(L.isStable('0.16.5') && !L.isStable('0.20.0-beta.9'));
  });

  await t('forge: список версий, установка через установщик, профиль и защита от ошибок', async () => {
    const crypto = require('crypto');
    const AdmZip = require('adm-zip');
    const L = src('minecraft/loaders');
    const V = src('minecraft/versions');
    const O = src('minecraft/optimize');
    const { gamePaths } = src('core/paths');

    // чистые функции
    const xml = '<metadata><versioning><versions><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version>'
      + '<version>1.20-46.0.14</version><version>1.12.2-14.23.5.2860</version></versions></versioning></metadata>';
    const list = L.parseForgeMetadata(xml, '1.20.1', { '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.3.0' });
    assert.deepStrictEqual(list.map((x) => x.version), ['47.3.0', '47.2.0']);
    assert.ok(list[1].stable && !list[0].stable);
    assert.deepStrictEqual(L.parseForgeMetadata(xml, '1.20', null).map((x) => x.version), ['46.0.14']);
    assert.ok(L.forgeSupportsMc('1.12.2') && L.forgeSupportsMc('1.21.1') && L.forgeSupportsMc('26.1'));
    assert.ok(!L.forgeSupportsMc('1.12.1') && !L.forgeSupportsMc('1.7.10'));
    assert.strictEqual(V.loaderFromId('1.20.1-forge-47.3.0', { inheritsFrom: '1.20.1' }), 'forge');
    assert.strictEqual(V.loaderFromId('forge-lookalike', null), null);
    assert.strictEqual(V.loaderFromId('fabric-loader-0.16.5-1.21.1', {}), 'fabric');

    // установщик Forge: jar с install_profile.json и version.json
    const mc = '1.20.1';
    const fv = '47.3.0';
    const pid = `${mc}-forge-${fv}`;
    const zip = new AdmZip();
    zip.addFile('install_profile.json', Buffer.from('{}'));
    zip.addFile('version.json', Buffer.from(JSON.stringify({ id: pid })));
    const installerJar = zip.toBuffer();
    const installerSha = crypto.createHash('sha1').update(installerJar).digest('hex');
    const srv = require('http').createServer((q, s) => {
      if (q.url === '/maven-metadata.xml') return s.end(xml);
      if (q.url === `/${mc}-${fv}/forge-${mc}-${fv}-installer.jar`) return s.end(installerJar);
      if (q.url === `/${mc}-${fv}/forge-${mc}-${fv}-installer.jar.sha1`) return s.end(installerSha);
      s.statusCode = 404; s.end('no');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('https://files.minecraftforge.net/')) {
        return new Response(JSON.stringify({ promos: { [`${mc}-recommended`]: '47.2.0', [`${mc}-latest`]: fv } }), { status: 200 });
      }
      if (u.startsWith('https://maven.minecraftforge.net/net/minecraftforge/forge')) {
        return realFetch(u.replace('https://maven.minecraftforge.net/net/minecraftforge/forge', base), opts);
      }
      return realFetch(url, opts);
    };

    const root = path.join(tmp, 'forgegame');
    const P = gamePaths(root);
    fs.mkdirSync(P.versionDir(mc), { recursive: true });
    fs.writeFileSync(P.versionJson(mc), JSON.stringify({ id: mc, type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
    fs.writeFileSync(P.versionJar(mc), 'vanilla-jar');
    const libRel = `net/minecraftforge/forge/${mc}-${fv}/forge-${mc}-${fv}-client.jar`;
    const writeProfile = (withLib) => {
      fs.mkdirSync(P.versionDir(pid), { recursive: true });
      fs.writeFileSync(P.versionJson(pid), JSON.stringify({
        id: pid, inheritsFrom: mc, type: 'release', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
        libraries: [{ name: `net.minecraftforge:forge:${mc}-${fv}:client`, downloads: { artifact: { path: libRel, url: '', sha1: 'x', size: 5 } } }],
        arguments: { jvm: ['-DlibraryDirectory=${library_directory}'], game: [] },
      }));
      if (withLib) {
        const dest = path.join(P.libraries, ...libRel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'patched');
      }
    };
    const fakeJava = { path: 'fake-java' };
    try {
      // список из maven + пометка рекомендуемой
      const got = await L.listLoaders('forge', mc);
      assert.deepStrictEqual(got.map((x) => `${x.version}:${x.stable}`), ['47.3.0:false', '47.2.0:true']);
      assert.deepStrictEqual(await L.listLoaders('forge', '1.7.10'), []);

      // успешная установка
      let calls = 0;
      const id = await L.installLoader(root, 'forge', mc, fv, {
        java: fakeJava,
        run: async (javaPath, jar, gameRoot, o) => {
          calls++;
          assert.strictEqual(javaPath, 'fake-java');
          assert.ok(fs.readFileSync(jar).equals(installerJar), 'установщик скачан и проверен');
          assert.strictEqual(gameRoot, root);
          assert.ok(fs.existsSync(path.join(root, 'launcher_profiles.json')), 'launcher_profiles.json создан');
          o.onLine('Processor 1/3');
          writeProfile(true);
        },
      });
      assert.strictEqual(id, pid);
      assert.strictEqual(calls, 1);
      assert.ok(!fs.existsSync(path.join(root, '.ewl-tmp')), 'временные файлы удалены');
      const d = await L.describe(root, pid);
      assert.strictEqual(d.kind, 'forge');
      assert.strictEqual(d.mc, mc);
      const inst = (await V.listInstalled(root)).find((x) => x.id === pid);
      assert.ok(inst && inst.loader === 'forge' && inst.mc === mc);
      const st = await O.status(root, pid);
      assert.ok(!st.supported && !st.canCreateProfile, 'моды Fabric на Forge не предлагаются');
      await assert.rejects(() => O.installMods({ root, versionId: pid }), /Fabric или Quilt/);

      // установщик отработал, но библиотеку не создал
      fs.rmSync(P.versionDir(pid), { recursive: true, force: true });
      fs.rmSync(P.libraries, { recursive: true, force: true });
      await assert.rejects(() => L.installLoader(root, 'forge', mc, fv, { java: fakeJava, run: async () => { writeProfile(false); } }), /Не найдена библиотека/);

      // установщик ничего не создал
      fs.rmSync(P.versionDir(pid), { recursive: true, force: true });
      await assert.rejects(() => L.installLoader(root, 'forge', mc, fv, { java: fakeJava, run: async () => {} }), /профиль не появился/);

      // ошибка установщика пробрасывается; старые версии отклоняются
      await assert.rejects(() => L.installLoader(root, 'forge', mc, fv, { java: fakeJava, run: async () => { throw new Error('boom'); } }), /boom/);
      await assert.rejects(() => L.installLoader(root, 'forge', '1.7.10', '10.13.4.1614', { java: fakeJava }), /минимум 1\.12\.2/);

      // битый установщик (не jar) определяется до запуска
      const bad = path.join(tmp, 'bad-installer.jar');
      fs.writeFileSync(bad, 'not a zip');
      assert.throws(() => L.readInstallerInfo(bad), /повреждён/);
    } finally { globalThis.fetch = realFetch; srv.close(); }

    // реальный запуск процесса: ненайденная Java и ненулевой код выхода с хвостом вывода
    await assert.rejects(() => L.runInstaller(path.join(tmp, 'no-such-java'), 'x.jar', root, {}), /Не удалось запустить Java/);
    const lines = [];
    await assert.rejects(() => L.runInstaller(process.execPath, path.join(tmp, 'x.jar'), root, { onLine: (l) => lines.push(l) }), /код \d+/);
    assert.ok(lines.length > 0, 'вывод установщика читается построчно');
  });

  await t('launch.resolveClientJar: Forge получает jar под именем профиля, Fabric — jar родителя', async () => {
    const { resolveClientJar } = src('minecraft/launch');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'jargame');
    const P = gamePaths(root);
    fs.mkdirSync(P.versionDir('1.20.1'), { recursive: true });
    fs.writeFileSync(P.versionJar('1.20.1'), 'client-bytes');
    const forge = { inheritsFrom: '1.20.1', _jarId: '1.20.1', arguments: { jvm: ['-DignoreList=a,${version_name}.jar'] } };
    const p1 = await resolveClientJar(root, forge, '1.20.1-forge-47.4.28');
    assert.strictEqual(p1, P.versionJar('1.20.1-forge-47.4.28'));
    assert.strictEqual(fs.readFileSync(p1, 'utf8'), 'client-bytes');
    fs.writeFileSync(P.versionJar('1.20.1'), 'client-bytes-v2'); // родитель обновился — копия обновляется
    assert.strictEqual(fs.readFileSync(await resolveClientJar(root, forge, '1.20.1-forge-47.4.28'), 'utf8'), 'client-bytes-v2');
    const fabric = { inheritsFrom: '1.20.1', _jarId: '1.20.1', arguments: { jvm: ['-cp', '${classpath}'] } };
    assert.strictEqual(await resolveClientJar(root, fabric, 'fabric-loader-0.16.5-1.20.1'), P.versionJar('1.20.1'));
    assert.strictEqual(await resolveClientJar(root, { _jarId: '1.20.1' }, '1.20.1'), P.versionJar('1.20.1'));
  });

  await t('optimize: выбор версии/файла и защита имени файла', () => {
    const O = src('minecraft/optimize');
    const v = O.pickVersion([
      { version_type: 'beta', date_published: '2026-09-01', files: [{ filename: 'a.jar' }] },
      { version_type: 'release', date_published: '2026-01-01', files: [{ filename: 'b-src.zip' }, { filename: 'b.jar', primary: true }] },
      { version_type: 'release', date_published: '2026-05-01', files: [{ filename: 'c.jar' }] },
    ]);
    assert.strictEqual(O.pickFile(v).filename, 'c.jar');
    assert.strictEqual(O.pickVersion([{ version_type: 'release', files: [{ filename: 'x.zip' }] }]), null);
    assert.throws(() => O.safeFileName('../evil.jar'));
    assert.throws(() => O.safeFileName('a/b.jar'));
    assert.throws(() => O.safeFileName('evil.exe'));
    assert.strictEqual(O.safeFileName('sodium-fabric-0.8.13+mc1.21.1.jar'), 'sodium-fabric-0.8.13+mc1.21.1.jar');
  });

  await t('optimize.installMods: зависимости, sha1, повторная установка, чужие моды', async () => {
    const crypto = require('crypto');
    const O = src('minecraft/optimize');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'optgame');
    const id = 'fabric-loader-0.16.5-1.21.1';
    const P = gamePaths(root);
    fs.mkdirSync(P.versionDir(id), { recursive: true });
    fs.writeFileSync(P.versionJson(id), JSON.stringify({ id, inheritsFrom: '1.21.1', type: 'release' }));

    const files = { sodium: crypto.randomBytes(5000), 'fabric-api': crypto.randomBytes(7000), lithium: crypto.randomBytes(3000) };
    const srv = require('http').createServer((q, s) => { const k = q.url.slice(1); s.end(files[k] || ''); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mk = (name, pid, deps = []) => ({
      project_id: pid, name, version_number: '1.0', version_type: 'release', date_published: '2026-01-01', dependencies: deps,
      files: [{ primary: true, filename: `${name}.jar`, url: `${base}/${name}`, size: files[name].length, hashes: { sha1: crypto.createHash('sha1').update(files[name]).digest('hex') } }],
    });
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      seen.push(u);
      const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
      if (u.includes('/project/sodium/version')) return json([mk('sodium', 'P1', [{ project_id: 'FAPI', dependency_type: 'required' }, { project_id: 'OPT', dependency_type: 'optional' }])]);
      if (u.includes('/project/FAPI/version')) return json([mk('fabric-api', 'P2')]);
      if (u.includes('/project/lithium/version')) return json([mk('lithium', 'P3')]);
      return json({ error: 'not found' }, 404); // остальные моды недоступны для версии
    };
    try {
      let last = [];
      const r = await O.installMods({ root, versionId: id, slugs: ['sodium', 'lithium', 'ferrite-core'], onProgress: (p) => last.push(p.fraction) });
      const names = r.installed.map((m) => m.name).sort();
      assert.deepStrictEqual(names, ['fabric-api', 'lithium', 'sodium'].map((n) => (n === 'fabric-api' ? 'fabric-api' : n.charAt(0).toUpperCase() + n.slice(1))).sort());
      assert.ok(r.skipped.some((x) => x.slug === 'ferrite-core'));
      assert.ok(!seen.some((x) => x.includes('/project/OPT/')), 'необязательные зависимости не ставятся');
      const modsDir = path.join(P.instance(id), 'mods');
      assert.ok(fs.readFileSync(path.join(modsDir, 'sodium.jar')).equals(files.sodium));
      let st = await O.status(root, id);
      assert.ok(st.supported && st.installed && st.kind === 'fabric' && st.mc === '1.21.1');
      const st2 = await O.status(root, '1.21.1');
      assert.ok(!st2.supported);
      // чужой мод не дублируется и не трогается
      fs.writeFileSync(path.join(modsDir, 'lithium-fabric-manual.jar'), 'x');
      await O.removeMods(root, id);
      assert.ok(!fs.existsSync(path.join(modsDir, 'sodium.jar')));
      assert.ok(fs.existsSync(path.join(modsDir, 'lithium-fabric-manual.jar')), 'чужие файлы остаются');
      const r2 = await O.installMods({ root, versionId: id, slugs: ['sodium', 'lithium'] });
      assert.ok(r2.skipped.some((x) => x.slug === 'lithium' && /уже есть/.test(x.reason)));
      st = await O.status(root, id);
      assert.ok(st.installed);
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('neoforge: версии, установка через установщик, определение профиля', async () => {
    const crypto = require('crypto');
    const AdmZip = require('adm-zip');
    const L = src('minecraft/loaders');
    const V = src('minecraft/versions');
    const { gamePaths } = src('core/paths');

    const xml = '<metadata><versioning><versions><version>21.0.5</version><version>21.1.0-beta</version><version>21.1.172</version>'
      + '<version>21.1.200</version><version>20.4.237</version><version>21.10.3</version></versions></versioning></metadata>';
    assert.deepStrictEqual(L.parseNeoForgeMetadata(xml, '1.21.1').map((x) => `${x.version}:${x.stable}`), ['21.1.200:true', '21.1.172:true', '21.1.0-beta:false']);
    assert.deepStrictEqual(L.parseNeoForgeMetadata(xml, '1.21').map((x) => x.version), ['21.0.5']);
    assert.deepStrictEqual(L.parseNeoForgeMetadata(xml, '1.20.4').map((x) => x.version), ['20.4.237']);
    assert.ok(L.neoforgeSupportsMc('1.20.2') && L.neoforgeSupportsMc('1.21.1') && L.neoforgeSupportsMc('26.1'));
    assert.ok(!L.neoforgeSupportsMc('1.20.1') && !L.neoforgeSupportsMc('1.19.4'));
    assert.strictEqual(V.loaderFromId('neoforge-21.1.172', { inheritsFrom: '1.21.1' }), 'neoforge');
    assert.strictEqual(V.loaderFromId('1.20.1-forge-47.4.28', { inheritsFrom: '1.20.1' }), 'forge');

    const mc = '1.21.1';
    const nv = '21.1.172';
    const pid = `neoforge-${nv}`;
    const zip = new AdmZip();
    zip.addFile('install_profile.json', Buffer.from('{}'));
    zip.addFile('version.json', Buffer.from(JSON.stringify({ id: pid })));
    const jarBytes = zip.toBuffer();
    const sha = crypto.createHash('sha1').update(jarBytes).digest('hex');
    const srv = require('http').createServer((q, s2) => {
      if (q.url === '/maven-metadata.xml') return s2.end(xml);
      if (q.url === `/${nv}/neoforge-${nv}-installer.jar`) return s2.end(jarBytes);
      if (q.url === `/${nv}/neoforge-${nv}-installer.jar.sha1`) return s2.end(sha);
      s2.statusCode = 404; s2.end('no');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('https://maven.neoforged.net/releases/net/neoforged/neoforge')) {
        return realFetch(u.replace('https://maven.neoforged.net/releases/net/neoforged/neoforge', base), opts);
      }
      return realFetch(url, opts);
    };
    const root = path.join(tmp, 'neogame');
    const P = gamePaths(root);
    fs.mkdirSync(P.versionDir(mc), { recursive: true });
    fs.writeFileSync(P.versionJson(mc), JSON.stringify({ id: mc, type: 'release', mainClass: 'x', libraries: [] }));
    fs.writeFileSync(P.versionJar(mc), 'vanilla');
    try {
      assert.deepStrictEqual((await L.listLoaders('neoforge', mc)).map((x) => x.version), ['21.1.200', '21.1.172', '21.1.0-beta']);
      assert.deepStrictEqual(await L.listLoaders('neoforge', '1.20.1'), []);
      const id = await L.installLoader(root, 'neoforge', mc, nv, {
        java: { path: 'fake-java' },
        run: async (javaPath, jar) => {
          assert.ok(fs.readFileSync(jar).equals(jarBytes));
          fs.mkdirSync(P.versionDir(pid), { recursive: true });
          fs.writeFileSync(P.versionJson(pid), JSON.stringify({ id: pid, inheritsFrom: mc, type: 'release', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [] }));
        },
      });
      assert.strictEqual(id, pid);
      const d = await L.describe(root, pid);
      assert.strictEqual(d.kind, 'neoforge');
      assert.strictEqual(d.mc, mc);
      await assert.rejects(() => L.installLoader(root, 'neoforge', '1.20.1', '47.1.106', { java: { path: 'x' } }), /минимум 1\.20\.2/);
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('libs: Fabric API ставится вместе с профилем, не дублируется и не удаляется оптимизацией', async () => {
    const crypto = require('crypto');
    const Libs = src('minecraft/libs');
    const O = src('minecraft/optimize');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'libgame');
    const P = gamePaths(root);
    const mkProfile = (id, mc) => {
      fs.mkdirSync(P.versionDir(id), { recursive: true });
      fs.writeFileSync(P.versionJson(id), JSON.stringify({ id, inheritsFrom: mc, type: 'release' }));
    };
    mkProfile('fabric-loader-0.16.5-1.21.1', '1.21.1');
    mkProfile('quilt-loader-0.26.0-1.21.1', '1.21.1');
    mkProfile('1.21.1-forge-52.0.0', '1.21.1');

    const files = { 'fabric-api': crypto.randomBytes(4000), qfapi: crypto.randomBytes(3000), qsl: crypto.randomBytes(2000) };
    const srv = require('http').createServer((q, s2) => s2.end(files[q.url.slice(1)] || ''));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mk = (name, pid, deps = []) => ({
      project_id: pid, name, version_number: '1.0', version_type: 'release', date_published: '2026-01-01', dependencies: deps,
      files: [{ primary: true, filename: `${name}-1.0.jar`, url: `${base}/${name}`, size: files[name].length, hashes: { sha1: crypto.createHash('sha1').update(files[name]).digest('hex') } }],
    });
    const realFetch = globalThis.fetch;
    let qfapiAvailable = true;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
      if (u.includes('/project/fabric-api/version')) return json([mk('fabric-api', 'FAPI')]);
      if (u.includes('/project/qfapi/version')) return qfapiAvailable ? json([mk('qfapi', 'QFAPI', [{ project_id: 'QSL', dependency_type: 'required' }])]) : json([]);
      if (u.includes('/project/QSL/version')) return json([mk('qsl', 'QSL')]);
      return json({ error: 'no' }, 404);
    };
    try {
      const fabId = 'fabric-loader-0.16.5-1.21.1';
      assert.deepStrictEqual(await Libs.status(root, fabId), { supported: true, title: 'Fabric API', present: false });
      assert.strictEqual((await Libs.status(root, '1.21.1-forge-52.0.0')).supported, false);
      const r = await Libs.installLibraries({ root, versionId: fabId });
      assert.deepStrictEqual(r.installed.map((m) => m.name), ['fabric-api']);
      const mods = path.join(P.instance(fabId), 'mods');
      assert.ok(fs.readFileSync(path.join(mods, 'fabric-api-1.0.jar')).equals(files['fabric-api']));
      assert.ok((await Libs.status(root, fabId)).present);
      const again = await Libs.installLibraries({ root, versionId: fabId });
      assert.ok(again.installed.length === 0 && /уже/.test(again.skipped[0].reason));
      assert.deepStrictEqual(await Libs.installLibraries({ root, versionId: '1.21.1-forge-52.0.0' }), { installed: [], skipped: [] });

      // Quilt: Quilted Fabric API + обязательная зависимость QSL; если её нет — запасной Fabric API
      const qId = 'quilt-loader-0.26.0-1.21.1';
      const rq = await Libs.installLibraries({ root, versionId: qId });
      assert.deepStrictEqual(rq.installed.map((m) => m.name).sort(), ['qfapi', 'qsl']);
      fs.rmSync(path.join(P.instance(qId), 'mods'), { recursive: true, force: true });
      qfapiAvailable = false;
      assert.deepStrictEqual((await Libs.installLibraries({ root, versionId: qId })).installed.map((m) => m.name), ['fabric-api']);

      // оптимизация не трогает библиотеку: удаление «оптимизации» оставляет Fabric API на месте
      fs.writeFileSync(path.join(mods, '.ewl-libs.json'), JSON.stringify({ mods: [{ filename: 'fabric-api-1.0.jar' }] }));
      await O.removeMods(root, fabId);
      assert.ok(fs.existsSync(path.join(mods, 'fabric-api-1.0.jar')));
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('skins: проверка PNG, библиотека, загрузка и текущий скин Microsoft', async () => {
    const zlib = require('zlib');
    const Sk = src('skins/skins');
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]);
    };
    const makePng = (w, hh) => {
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hh, 4); ihdr[8] = 8; ihdr[9] = 6;
      const raw = Buffer.alloc(hh * (1 + w * 4));
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    };
    const png = makePng(64, 64);
    assert.deepStrictEqual(Sk.validatePng(png), { width: 64, height: 64 });
    assert.strictEqual(Sk.validatePng(makePng(64, 32)).height, 32);
    assert.throws(() => Sk.validatePng(makePng(128, 128)), /Размер скина/);
    assert.throws(() => Sk.validatePng(Buffer.from('not png at all, definitely not a png file')), /не PNG/);
    assert.throws(() => Sk.parseDataUrl('data:image/jpeg;base64,AAAA'), /PNG/);

    const svc = new Sk.SkinService(path.join(tmp, 'skins'));
    const url = Sk.toDataUrl(png);
    assert.strictEqual(await svc.save('Мой скин', url), 'Мой скин');
    fs.writeFileSync(path.join(tmp, 'skins', 'junk.png'), 'broken');
    const list = await svc.list();
    assert.deepStrictEqual(list.map((x) => x.name), ['Мой скин']);
    assert.strictEqual(list[0].dataUrl, url);
    await assert.rejects(() => svc.save('../evil', url), /Название скина/);
    await assert.rejects(() => svc.save('con', url), /Название скина/);
    await svc.remove('Мой скин');
    assert.strictEqual((await svc.list()).length, 0);

    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (u, opts = {}) => {
      const x = String(u);
      calls.push({ url: x, method: opts.method || 'GET', auth: opts.headers && opts.headers.Authorization, body: opts.body });
      if (x === 'https://api.minecraftservices.com/minecraft/profile/skins') return new Response('{}', { status: opts.headers.Authorization === 'Bearer good' ? 200 : 401 });
      if (x.startsWith('https://sessionserver.mojang.com/session/minecraft/profile/')) {
        const value = Buffer.from(JSON.stringify({ textures: { SKIN: { url: 'https://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } } } })).toString('base64');
        return new Response(JSON.stringify({ properties: [{ name: 'textures', value }] }), { status: 200 });
      }
      if (x === 'https://textures.minecraft.net/texture/abc') return new Response(png, { status: 200 });
      return new Response('no', { status: 404 });
    };
    try {
      assert.ok(await Sk.uploadSkin('good', png, 'slim'));
      const up = calls.find((c) => c.method === 'POST');
      assert.strictEqual(up.auth, 'Bearer good');
      assert.strictEqual(up.body.get('variant'), 'slim');
      assert.strictEqual(up.body.get('file').type, 'image/png');
      await assert.rejects(() => Sk.uploadSkin('stale', png, 'classic'), /войдите в аккаунт заново/);
      await assert.rejects(() => Sk.uploadSkin('good', Buffer.from('nope nope nope nope nope nope nope nope'), 'classic'), /не PNG/);
      const cur = await Sk.fetchCurrentSkin('b50ad385-829d-3141-a216-7e7d7539ba7f');
      assert.strictEqual(cur.variant, 'slim');
      assert.strictEqual(cur.dataUrl, url);
      await assert.rejects(() => Sk.fetchCurrentSkin('not-a-uuid'), /UUID/);
    } finally { globalThis.fetch = realFetch; }
  });

  await t('settings: имена сборок и приветствие; versions.removeInstance', async () => {
    const { normalize, DEFAULTS } = src('settings/settings');
    const V = src('minecraft/versions');
    const { gamePaths } = src('core/paths');
    const base = DEFAULTS();
    assert.strictEqual(base.welcomeAnimation, true);
    const s = normalize({ welcomeAnimation: false, profileNames: { a: '  Моя   сборка ', b: '', c: 5, ['x'.repeat(101)]: 'long key' } }, base);
    assert.strictEqual(s.welcomeAnimation, false);
    assert.deepStrictEqual(s.profileNames, { a: 'Моя   сборка' });
    assert.deepStrictEqual(normalize({ profileNames: {} }, s).profileNames, {}, 'пустой объект сбрасывает все имена');
    assert.deepStrictEqual(normalize({ profileNames: [1, 2] }, s).profileNames, { a: 'Моя   сборка' }, 'массив игнорируется');
    assert.strictEqual(normalize({ profileNames: { z: 'я'.repeat(80) } }, s).profileNames.z.length, 40);

    const root = path.join(tmp, 'rmgame');
    const P = gamePaths(root);
    fs.mkdirSync(path.join(P.instance('fabric-loader-0.16.5-1.21.1'), 'saves', 'world'), { recursive: true });
    fs.mkdirSync(P.versionDir('fabric-loader-0.16.5-1.21.1'), { recursive: true });
    fs.writeFileSync(P.versionJson('fabric-loader-0.16.5-1.21.1'), '{}');
    await V.removeVersion(root, 'fabric-loader-0.16.5-1.21.1');
    assert.ok(fs.existsSync(P.instance('fabric-loader-0.16.5-1.21.1')), 'миры остаются, если данные не просили удалять');
    await V.removeInstance(root, 'fabric-loader-0.16.5-1.21.1');
    assert.ok(!fs.existsSync(P.instance('fabric-loader-0.16.5-1.21.1')));
    await assert.rejects(() => V.removeInstance(root, '../evil'));
  });

  await t('crash: разбор реальных ошибок вылета', async () => {
    const C = src('minecraft/crash');
    const ids = (lines, extra = {}) => C.analyze({ lines: lines.split('\n'), code: 1, ...extra }).findings.map((f) => f.id);

    // реальный вылет Forge из лога пользователя
    assert.deepStrictEqual(ids('Exception in thread "main" java.lang.module.ResolutionException: Modules _1._20._1 and minecraft export package com.mojang.blaze3d.platform to module forge\n\tat java.base/java.lang.module.Resolver.resolveFail(Resolver.java:901)'), ['module-conflict']);
    assert.ok(ids('Exception in thread "main" java.lang.module.ResolutionException: Module minecraft contains package net.minecraft.data, module _1._20._1 exports package net.minecraft.data to minecraft').includes('module-conflict'));

    // версия Java
    const j = C.analyze({ lines: ['java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0'], code: 1, javaMajor: 17 });
    assert.strictEqual(j.findings[0].id, 'java-too-old');
    assert.match(j.findings[0].title, /\(21\+\)/);
    assert.match(j.findings[0].cause, /Java 17/);
    assert.ok(ids("Mod 'Sodium' (sodium) 0.6.0 requires version 21 or later of Java Runtime, which is missing!").includes('java-too-old'));

    // память
    const oom = C.analyze({ lines: ['Exception in thread "Render thread" java.lang.OutOfMemoryError: Java heap space'], code: 1, ram: 2048 });
    assert.strictEqual(oom.findings[0].id, 'out-of-memory');
    assert.match(oom.findings[0].cause, /2048 МБ/);
    assert.deepStrictEqual(ids('Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap'), ['heap-reserve']);
    assert.deepStrictEqual(ids('Unrecognized VM option \'UseConcMarkSweepGC\'\nError: Could not create the Java Virtual Machine.'), ['bad-jvm-args']);

    // Fabric: нет Fabric API (форматы разных версий загрузчика)
    const fab = C.analyze({ lines: ['net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!', 'A potential solution has been determined, this may resolve your problem:', '\t - Install fabric-api, version 0.92.0 or later.', "\t - Mod 'Sodium' (sodium) 0.5.3 requires any version of fabric-api, which is missing!"], code: 1 });
    assert.strictEqual(fab.findings[0].id, 'fabric-missing-dep');
    assert.strictEqual(fab.findings[0].action, 'libs');
    assert.deepStrictEqual(fab.findings[0].mods, ['fabric-api']);
    const dep = C.analyze({ lines: ["\t - Mod 'Create' (create) 0.5 requires version 1.0.0 or later of mod 'flywheel', which is missing!"], code: 1 });
    assert.strictEqual(dep.findings[0].action, 'market');
    assert.deepStrictEqual(dep.findings[0].mods, ['flywheel']);
    assert.ok(!ids("requires any version of minecraft, which is missing").includes('fabric-missing-dep'), 'minecraft/java не считаются модом-зависимостью');

    // Forge: отсутствующие зависимости
    const fg = C.analyze({ lines: ['Missing or unsupported mandatory dependencies:', "\tMod ID: 'architectury', Requested by: 'jei_addon', Expected range: '[9.0.0,)', Actual version: '[MISSING]'", "\tMod ID: 'minecraft', Requested by: 'x', Expected range: '[1.20.1]', Actual version: '1.20.4'"], code: 1 });
    assert.ok(fg.findings.some((f) => f.id === 'forge-missing-dep' && f.mods.includes('architectury')));
    assert.ok(fg.findings.some((f) => f.id === 'wrong-mc-version'));

    // мод в entrypoint, Mixin, отсутствующие классы
    assert.deepStrictEqual(C.analyze({ lines: ["net.fabricmc.loader.api.EntrypointException: Could not execute entrypoint stage 'main' due to errors, provided by 'badmod'!"], code: 1 }).findings[0].mods, ['badmod']);
    const mx = C.analyze({ lines: ['org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered', 'Mixin apply failed examplemod.mixins.json:ServerMixin -> net.minecraft.server.Main'], code: 1 });
    assert.strictEqual(mx.findings[0].id, 'mixin');
    assert.deepStrictEqual(mx.findings[0].mods, ['examplemod']);
    assert.ok(ids('java.lang.NoSuchMethodError: \'void net.minecraft.client.Foo.bar()\'').includes('missing-class'));
    assert.ok(ids('Found duplicate mods: sodium').includes('duplicate-mods'));

    // повреждённые файлы и драйверы
    assert.ok(ids('Error: Could not find or load main class net.minecraft.client.main.Main\nCaused by: java.lang.ClassNotFoundException: net.minecraft.client.main.Main').includes('corrupt-files'));
    assert.ok(ids('java.util.zip.ZipException: invalid LOC header (bad signature)').includes('corrupt-files'));
    assert.ok(ids('[main/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL').includes('gpu-driver'));
    const hs = C.analyze({ lines: [], hsErr: '# A fatal error has been detected by the Java Runtime Environment:\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005)\n# Problematic frame:\n# C  [atio6axx.dll+0x123abc]', code: -1073741819 });
    assert.strictEqual(hs.findings[0].id, 'jvm-crash');
    assert.match(hs.findings[0].cause, /AMD/);
    assert.match(hs.exitInfo, /0xC0000005/);
    assert.ok(ids('java.io.FileNotFoundException: C:\\g\\libraries\\net\\minecraft\\client\\1.20.1-20230612.114412\\client-1.20.1-20230612.114412-srg.jar (Не удаётся найти указанный файл)').includes('forge-patched-client-missing'));

    // авторизация, сеть, диск, доступ, нативные библиотеки
    assert.ok(ids('Failed to verify username!').includes('auth'));
    assert.ok(ids('java.net.UnknownHostException: sessionserver.mojang.com').includes('network'));
    assert.ok(ids('java.io.IOException: There is not enough space on the disk').includes('disk-full'));
    assert.ok(ids('java.nio.file.AccessDeniedException: C:\\g\\mods\\x.jar').includes('file-locked'));
    assert.ok(ids('java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll').includes('natives'));

    // Java не запустилась, неизвестный код и пустой лог
    const nj = C.analyze({ lines: [], code: -1, error: 'Не удалось запустить Java: spawn ENOENT' });
    assert.strictEqual(nj.findings[0].id, 'java-launch');
    const unk = C.analyze({ lines: ['Process finished'], code: -805306369 });
    assert.strictEqual(unk.findings[0].id, 'exit-code');
    assert.deepStrictEqual(C.analyze({ lines: ['всё штатно'], code: 1 }).findings, []);

    // crash-report: суть и подозреваемые моды
    const rep = ['---- Minecraft Crash Report ----', 'Description: Rendering screen', 'java.lang.NullPointerException: Cannot invoke "x" because "y" is null', '', '-- Suspected Mods --', 'Suspected Mods: ', '\tBadMod (badmod), Sodium (sodium)', ''].join('\n');
    const sm = C.summarize(rep);
    assert.strictEqual(sm.description, 'Rendering screen');
    assert.match(sm.exception, /NullPointerException/);
    assert.deepStrictEqual(sm.suspects, ['BadMod (badmod), Sodium (sodium)']);

    // чтение свежего crash-report: старые файлы игнорируются
    const dir = path.join(tmp, 'crashgame');
    fs.mkdirSync(path.join(dir, 'crash-reports'), { recursive: true });
    const oldF = path.join(dir, 'crash-reports', 'crash-old.txt');
    fs.writeFileSync(oldF, 'old');
    fs.utimesSync(oldF, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
    assert.strictEqual((await C.readCrashContext(dir, Date.now() - 1000)).crashReport, '');
    fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-new.txt'), rep);
    fs.writeFileSync(path.join(dir, 'hs_err_pid42.log'), '# Problematic frame:');
    const got = await C.readCrashContext(dir, Date.now() - 1000);
    assert.ok(got.crashReport.includes('Rendering screen') && got.hsErr.includes('Problematic') && /crash-new/.test(got.crashFile));
  });

  await t('market: поиск под версию и загрузчик, установка с зависимостями, список и удаление', async () => {
    const crypto = require('crypto');
    const M = src('market/market');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'marketgame');
    const P = gamePaths(root);
    const prof = '1.20.1-forge-47.4.28';
    fs.mkdirSync(P.versionDir(prof), { recursive: true });
    fs.writeFileSync(P.versionJson(prof), JSON.stringify({ id: prof, inheritsFrom: '1.20.1', type: 'release' }));
    fs.mkdirSync(P.versionDir('1.20.1'), { recursive: true });
    fs.writeFileSync(P.versionJson('1.20.1'), JSON.stringify({ id: '1.20.1', type: 'release' }));

    // фасеты: тип, версия, загрузчики (Quilt принимает и Fabric), клиентская сторона
    assert.deepStrictEqual(JSON.parse(M.buildFacets({ mc: '1.20.1', kind: 'quilt' })), [['project_type:mod'], ['versions:1.20.1'], ['categories:quilt', 'categories:fabric'], ['client_side:required', 'client_side:optional']]);
    assert.deepStrictEqual(JSON.parse(M.buildFacets({ mc: '1.21.1', kind: 'neoforge' }))[2], ['categories:neoforge']);

    const files = { jei: crypto.randomBytes(3000), architectury: crypto.randomBytes(2000) };
    const srv = require('http').createServer((q, s2) => s2.end(files[q.url.slice(1)] || ''));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mk = (name, pid, deps = []) => ({
      project_id: pid, name, version_number: '2.0', version_type: 'release', date_published: '2026-02-01', dependencies: deps,
      files: [{ primary: true, filename: `${name}-forge-2.0.jar`, url: `${base}/${name}`, size: files[name].length, hashes: { sha1: crypto.createHash('sha1').update(files[name]).digest('hex') } }],
    });
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      seen.push(u);
      const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
      if (u.startsWith('https://api.modrinth.com/v2/search')) {
        return json({ total_hits: 41, offset: 0, hits: [
          { project_id: 'JEIID', slug: 'jei', title: 'JEI', author: 'mezz', description: 'Просмотр рецептов', downloads: 250000000, icon_url: 'https://cdn.modrinth.com/data/JEIID/icon.png', categories: ['forge', 'utility'], date_modified: '2026-03-01T00:00:00Z' },
          { project_id: 'EVIL', slug: 'evil', title: 'Evil', author: 'x', description: 'd', downloads: 1, icon_url: 'https://evil.example/track.png', categories: [] },
        ] });
      }
      if (u.includes('/project/JEIID/version')) return json([mk('jei', 'JEIID', [{ project_id: 'ARCH', dependency_type: 'required' }])]);
      if (u.includes('/project/ARCH/version')) return json([mk('architectury', 'ARCH')]);
      return json({ error: 'no' }, 404);
    };
    try {
      const r = await M.search({ query: 'jei', mc: '1.20.1', kind: 'forge', sort: 'downloads', offset: 20, limit: 20 });
      assert.strictEqual(r.total, 41);
      assert.strictEqual(r.hits[0].icon, 'https://cdn.modrinth.com/data/JEIID/icon.png');
      assert.strictEqual(r.hits[1].icon, '', 'картинки не с cdn.modrinth.com отбрасываются');
      const q = new URL(seen.find((x) => x.includes('/search')));
      assert.strictEqual(q.searchParams.get('index'), 'downloads');
      assert.strictEqual(q.searchParams.get('offset'), '20');
      assert.strictEqual(q.searchParams.get('query'), 'jei');
      assert.ok(q.searchParams.get('facets').includes('versions:1.20.1') && q.searchParams.get('facets').includes('categories:forge'));
      await assert.rejects(() => M.search({ mc: '1.20.1', kind: null }), /только в профили/);
      await assert.rejects(() => M.search({ source: 'curseforge', mc: '1.20.1', kind: 'forge' }), /Не указан ключ/);

      const ins = await M.install({ root, versionId: prof, project: 'JEIID', title: 'JEI' });
      assert.deepStrictEqual(ins.installed.map((m) => [m.title, m.dependency]), [['JEI', false], ['architectury', true]]);
      const mods = path.join(P.instance(prof), 'mods');
      assert.ok(fs.readFileSync(path.join(mods, 'jei-forge-2.0.jar')).equals(files.jei));
      assert.ok(fs.readFileSync(path.join(mods, 'architectury-forge-2.0.jar')).equals(files.architectury));
      const list = await M.listInstalled({ root, versionId: prof });
      assert.deepStrictEqual(list.map((m) => `${m.title}|${m.tag}`), ['architectury|Зависимость', 'JEI|Маркет'], 'сортировка по названию');
      assert.ok(list.some((m) => m.projectId === 'JEIID'));

      const again = await M.install({ root, versionId: prof, project: 'JEIID', title: 'JEI' });
      assert.strictEqual(again.installed.length, 0);
      assert.ok(again.skipped.every((x) => /уже/.test(x.reason)));
      await assert.rejects(() => M.install({ root, versionId: '1.20.1', project: 'JEIID' }), /только в профили/);
      await assert.rejects(() => M.install({ root, versionId: prof, project: '../x' }), /Некорректный идентификатор/);
      await assert.rejects(() => M.install({ root, versionId: prof, project: 'NOPE' }), /нет подходящей версии/);

      await assert.rejects(() => M.remove({ root, versionId: prof, filename: '../evil.jar' }), /Небезопасное имя/);
      await M.remove({ root, versionId: prof, filename: 'jei-forge-2.0.jar' });
      assert.ok(!fs.existsSync(path.join(mods, 'jei-forge-2.0.jar')));
      assert.ok(!(await M.listInstalled({ root, versionId: prof })).some((m) => m.title === 'JEI'));
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('settings: accent и список отказов от оптимизации', () => {
    const { normalize, DEFAULTS } = src('settings/settings');
    const s = normalize({ accent: '#FF8800', optimizeDeclined: ['a', 'a', 'b'] }, DEFAULTS());
    assert.strictEqual(s.accent, '#ff8800');
    assert.deepStrictEqual(s.optimizeDeclined, ['a', 'b']);
    assert.strictEqual(normalize({ accent: 'red' }, s).accent, '#ff8800');
  });

  await t('settings: profileConfig нормализуется', () => {
    const { normalize, DEFAULTS } = src('settings/settings');
    const s = normalize({ profileConfig: { a: { ramMax: 4096, jvmArgs: 'x\ny' }, b: { ramMax: 0, jvmArgs: '' }, c: 5 } }, DEFAULTS());
    assert.deepStrictEqual(Object.keys(s.profileConfig), ['a']);
    assert.strictEqual(s.profileConfig.a.jvmArgs, 'x y');
    assert.strictEqual(s.profileConfig.a.ramMax, 4096);
  });

  await t('profiles: бэкап, восстановление, копия, экспорт и импорт', async () => {
    const P = src('profiles/profiles');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'pgame');
    const G = gamePaths(root);
    const id = 'fabric-loader-0.16.0-1.21';
    fs.mkdirSync(G.versionDir(id), { recursive: true });
    fs.writeFileSync(G.versionJson(id), JSON.stringify({ id, inheritsFrom: '1.21', libraries: [] }));
    const inst = G.instance(id);
    fs.mkdirSync(path.join(inst, 'saves', 'World1'), { recursive: true });
    fs.writeFileSync(path.join(inst, 'saves', 'World1', 'level.dat'), 'AAA');
    fs.mkdirSync(path.join(inst, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(inst, 'mods', 'm.jar'), 'JAR');
    fs.writeFileSync(path.join(inst, 'options.txt'), 'lang:ru_ru');

    assert.strictEqual((await P.listWorlds(root, id))[0].name, 'World1');
    const b = await P.backupWorlds({ root, id });
    assert.deepStrictEqual(b.worlds, ['World1']);
    assert.strictEqual((await P.listBackups(root, id)).length, 1);
    fs.writeFileSync(path.join(inst, 'saves', 'World1', 'level.dat'), 'BBB');
    const r = await P.restoreBackup({ root, id, file: b.file });
    assert.strictEqual(fs.readFileSync(path.join(inst, 'saves', 'World1', 'level.dat'), 'utf8'), 'AAA');
    assert.strictEqual(r.kept.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(inst, 'saves', r.kept[0], 'level.dat'), 'utf8'), 'BBB');
    await assert.rejects(() => P.restoreBackup({ root, id, file: '../x.zip' }), /Некорректное/);
    await assert.rejects(() => P.backupWorlds({ root, id: 'empty-profile' }), /нет миров/);

    const d = await P.duplicate({ root, id });
    assert.strictEqual(d.id, `${id}-copy`);
    assert.strictEqual(JSON.parse(fs.readFileSync(G.versionJson(d.id), 'utf8')).id, d.id);
    assert.ok(fs.existsSync(path.join(G.instance(d.id), 'mods', 'm.jar')));

    const file = path.join(tmp, 'pack.zip');
    const ex = await P.exportProfile({ root, id, file, name: 'Моя', loader: 'fabric', mc: '1.21', config: { ramMax: 3072, jvmArgs: '' } });
    assert.ok(ex.parts.includes('mods') && !ex.parts.includes('saves'));
    // импорт в чистую папку: версия создаётся из архива
    const root2 = path.join(tmp, 'pgame2');
    const imp = await P.importProfile({ root: root2, file });
    assert.strictEqual(imp.id, id);
    assert.strictEqual(imp.config.ramMax, 3072);
    assert.strictEqual(fs.readFileSync(path.join(gamePaths(root2).instance(id), 'mods', 'm.jar'), 'utf8'), 'JAR');
    assert.ok(!fs.existsSync(path.join(gamePaths(root2).instance(id), 'saves')));
    // повторный импорт не затирает существующее
    const again = await P.importProfile({ root: root2, file });
    assert.strictEqual(again.id, `${id}-copy`);
    assert.ok(again.copied);
    // Forge без установленной версии — понятная ошибка
    const zf = new (require('adm-zip'))();
    zf.addFile('profile.json', Buffer.from(JSON.stringify({ format: 1, id: '1.20.1-forge-47.2.0', loader: 'forge' })));
    zf.addFile('version/1.20.1-forge-47.2.0.json', Buffer.from('{}'));
    const fz = path.join(tmp, 'forge.zip');
    zf.writeZip(fz);
    await assert.rejects(() => P.importProfile({ root: root2, file: fz }), /сначала установите/);
    // zip-slip: запись с ../ не выходит из папки профиля
    const zs = new (require('adm-zip'))();
    zs.addFile('profile.json', Buffer.from(JSON.stringify({ format: 1, id: 'evil-1', loader: 'fabric' })));
    zs.addFile('version/evil-1.json', Buffer.from('{"id":"evil-1"}'));
    zs.addFile('instance/../../pwned.txt', Buffer.from('x'));
    const sz = path.join(tmp, 'slip.zip');
    zs.writeZip(sz);
    await P.importProfile({ root: root2, file: sz });
    assert.ok(!fs.existsSync(path.join(root2, 'instances', 'pwned.txt')));
    assert.ok(!fs.existsSync(path.join(root2, 'pwned.txt')));
  });

  await t('modpacks: разбор .mrpack, защита путей и установка в новый профиль', async () => {
    const crypto = require('crypto');
    const AdmZip = require('adm-zip');
    const MP = src('market/modpacks');
    const loaders = src('minecraft/loaders');
    const { gamePaths } = src('core/paths');

    // разбор индекса
    const idx = (over = {}) => ({ formatVersion: 1, game: 'minecraft', name: 'Pack', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' }, files: [], ...over });
    assert.throws(() => MP.parseIndex({ formatVersion: 2 }), /формат/);
    assert.throws(() => MP.parseIndex(idx({ dependencies: { minecraft: '1.20.1' } })), /загрузчика/);
    const f = (p, extra = {}) => ({ path: p, hashes: { sha1: 'a'.repeat(40) }, downloads: ['https://cdn.modrinth.com/x.jar'], fileSize: 3, ...extra });
    const parsed = MP.parseIndex(idx({ files: [
      f('mods/ok.jar'), f('../evil.jar'), f('/abs.jar'), f('C:/win.jar'), f('mods/srv.jar', { env: { client: 'unsupported' } }),
      f('mods/badhost.jar', { downloads: ['https://evil.example/x.jar'] }), f('mods/nohash.jar', { hashes: {} }),
    ] }));
    assert.deepStrictEqual(parsed.files.map((x) => x.path), ['mods/ok.jar']);
    assert.strictEqual(parsed.kind, 'fabric');
    assert.strictEqual(MP.parseIndex(idx({ dependencies: { minecraft: '1.21.1', neoforge: '21.1.172' } })).kind, 'neoforge');

    // установка: API и загрузки идут на локальный сервер, установку загрузчика подменяем
    const modA = crypto.randomBytes(2500);
    const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
    const idxObj = idx({ files: [{ path: 'mods/a.jar', hashes: { sha1: sha(modA) }, downloads: ['http://127.0.0.1:PORT/a'], fileSize: modA.length }] });
    let mrpack;
    const srv = require('http').createServer((q, s2) => { if (q.url === '/a') s2.end(modA); else if (q.url === '/pack') s2.end(mrpack); else s2.end(''); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    idxObj.files[0].downloads[0] = `${base}/a`;
    const z = new AdmZip();
    z.addFile('modrinth.index.json', Buffer.from(JSON.stringify(idxObj)));
    z.addFile('overrides/config/pack.toml', Buffer.from('x=1'));
    z.addFile('client-overrides/options.txt', Buffer.from('lang:ru_ru'));
    z.addFile('overrides/../../escape.txt', Buffer.from('bad'));
    const tmpZip = path.join(tmp, 'pack.mrpack');
    z.writeZip(tmpZip);
    mrpack = fs.readFileSync(tmpZip);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      const json = (o) => new Response(JSON.stringify(o), { status: 200 });
      if (u.includes('/search')) return json({ total_hits: 1, offset: 0, hits: [{ project_id: 'PACK1', slug: 'p', title: 'P', author: 'a', description: 'd', downloads: 5, icon_url: '', categories: [] }] });
      return json([{ id: 'VER1', name: 'v1', version_number: '1', game_versions: ['1.20.1'], loaders: ['fabric'], files: [{ primary: true, filename: 'p.mrpack', url: `${base}/pack`, hashes: { sha1: sha(mrpack) } }] }]);
    };
    const origInstall = loaders.installLoader; const origList = loaders.listLoaders;
    const root = path.join(tmp, 'packgame');
    const G = gamePaths(root);
    loaders.listLoaders = async () => [{ version: '0.16.0', stable: true }];
    loaders.installLoader = async (r, kind, mc, ver) => {
      assert.deepStrictEqual([kind, mc, ver], ['fabric', '1.20.1', '0.16.0']);
      const id = 'fabric-loader-0.16.0-1.20.1';
      fs.mkdirSync(G.versionDir(id), { recursive: true });
      fs.writeFileSync(G.versionJson(id), JSON.stringify({ id, inheritsFrom: '1.20.1' }));
      return id;
    };
    MP.hooks.allowHost = (u) => u.startsWith('http://127.0.0.1');
    try {
      assert.strictEqual((await MP.search({ query: 'p' })).hits[0].id, 'PACK1');
      const vs = await MP.listVersions('PACK1');
      assert.strictEqual(vs[0].id, 'VER1');
      const r1 = await MP.install({ root, project: 'PACK1', settings: {} });
      assert.strictEqual(r1.id, 'fabric-loader-0.16.0-1.20.1');
      const inst = G.instance(r1.id);
      assert.ok(fs.readFileSync(path.join(inst, 'mods', 'a.jar')).equals(modA));
      assert.strictEqual(fs.readFileSync(path.join(inst, 'config', 'pack.toml'), 'utf8'), 'x=1');
      assert.strictEqual(fs.readFileSync(path.join(inst, 'options.txt'), 'utf8'), 'lang:ru_ru');
      assert.ok(!fs.existsSync(path.join(root, 'escape.txt')) && !fs.existsSync(path.join(root, 'instances', 'escape.txt')));
      // второй модпак с тем же загрузчиком не затирает первый: создаётся копия профиля
      const r2 = await MP.install({ root, project: 'PACK1', settings: {} });
      assert.strictEqual(r2.id, 'fabric-loader-0.16.0-1.20.1-copy');
      assert.ok(r2.copied && fs.existsSync(path.join(G.instance(r2.id), 'mods', 'a.jar')));
    } finally { globalThis.fetch = realFetch; loaders.installLoader = origInstall; loaders.listLoaders = origList; MP.hooks.allowHost = null; srv.close(); }
  });

  await t('market: проверка обновлений, обновление с бэкапом и откат', async () => {
    const crypto = require('crypto');
    const M = src('market/market');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'updgame');
    const P = gamePaths(root);
    const prof = '1.20.1-forge-47.4.28';
    fs.mkdirSync(P.versionDir(prof), { recursive: true });
    fs.writeFileSync(P.versionJson(prof), JSON.stringify({ id: prof, inheritsFrom: '1.20.1', type: 'release' }));
    fs.mkdirSync(P.versionDir('1.20.1'), { recursive: true });
    fs.writeFileSync(P.versionJson('1.20.1'), JSON.stringify({ id: '1.20.1', type: 'release' }));
    const v1 = Buffer.from('old-jar'); const v2 = crypto.randomBytes(1500);
    const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
    const srv = require('http').createServer((q, s2) => s2.end(v2));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mods = path.join(P.instance(prof), 'mods');
    fs.mkdirSync(mods, { recursive: true });
    fs.writeFileSync(path.join(mods, 'jei-1.0.jar'), v1);
    fs.writeFileSync(path.join(mods, '.ewl-market.json'), JSON.stringify({ mods: [{ projectId: 'JEIID', slug: 'JEIID', title: 'JEI', version: '1.0', filename: 'jei-1.0.jar', dependency: false, source: 'modrinth', at: '2026-01-01T00:00:00Z' }] }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      if (u.includes('/project/JEIID/version')) return new Response(JSON.stringify([{ project_id: 'JEIID', name: 'JEI', version_number: '2.0', version_type: 'release', date_published: '2026-02-01', dependencies: [], files: [{ primary: true, filename: 'jei-2.0.jar', url: `${base}/j`, size: v2.length, hashes: { sha1: sha(v2) } }] }]), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    try {
      const ups = await M.checkUpdates({ root, versionId: prof });
      assert.strictEqual(ups.length, 1);
      assert.strictEqual(ups[0].next, '2.0');
      const r = await M.update({ root, versionId: prof, projects: ['JEIID'] });
      assert.strictEqual(r.updated.length, 1);
      assert.ok(fs.existsSync(path.join(mods, 'jei-2.0.jar')) && !fs.existsSync(path.join(mods, 'jei-1.0.jar')), 'старый jar убран из mods');
      assert.ok(fs.existsSync(path.join(P.instance(prof), 'mods-backup', 'jei-1.0.jar')));
      assert.ok((await M.listInstalled({ root, versionId: prof })).find((m) => m.filename === 'jei-2.0.jar').hasPrevious);
      assert.strictEqual((await M.checkUpdates({ root, versionId: prof })).length, 0, 'после обновления новых нет');
      const rb = await M.rollback({ root, versionId: prof, projectId: 'JEIID' });
      assert.strictEqual(rb.version, '1.0');
      assert.ok(fs.readFileSync(path.join(mods, 'jei-1.0.jar')).equals(v1) && !fs.existsSync(path.join(mods, 'jei-2.0.jar')));
      await assert.rejects(() => M.rollback({ root, versionId: prof, projectId: 'JEIID' }), /нет сохранённой/);
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('market: ресурспаки и шейдеры', async () => {
    const crypto = require('crypto');
    const M = src('market/market');
    const { gamePaths } = src('core/paths');
    const root = path.join(tmp, 'contgame');
    const P = gamePaths(root);
    const prof = 'fabric-loader-0.16.0-1.21.1';
    fs.mkdirSync(P.versionDir(prof), { recursive: true });
    fs.writeFileSync(P.versionJson(prof), JSON.stringify({ id: prof, inheritsFrom: '1.21.1' }));
    fs.mkdirSync(P.versionDir('1.21.1'), { recursive: true });
    fs.writeFileSync(P.versionJson('1.21.1'), JSON.stringify({ id: '1.21.1', type: 'release' }));
    const body = crypto.randomBytes(1200);
    const sha = crypto.createHash('sha1').update(body).digest('hex');
    const srv = require('http').createServer((q, s2) => s2.end(body));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const realFetch = globalThis.fetch; const urls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.modrinth.com/v2/')) return realFetch(url, opts);
      urls.push(decodeURIComponent(u));
      if (u.includes('/search')) return new Response(JSON.stringify({ total_hits: 1, offset: 0, hits: [{ project_id: 'SHD', slug: 'bsl', title: 'BSL', author: 'x', description: 'd', downloads: 9, icon_url: '', categories: [] }] }));
      return new Response(JSON.stringify([
        { version_type: 'beta', version_number: 'b', files: [{ primary: true, filename: 'beta.zip', url: `${base}/b`, hashes: { sha1: 'x' } }] },
        { version_type: 'release', version_number: '8.0', files: [{ primary: true, filename: 'BSL_8.0.zip', url: `${base}/r`, size: body.length, hashes: { sha1: sha } }] }]));
    };
    try {
      const r = await M.searchContent({ type: 'shader', query: 'bsl', mc: '1.21.1' });
      assert.strictEqual(r.hits[0].title, 'BSL');
      assert.ok(urls[0].includes('project_type:shader') && urls[0].includes('versions:1.21.1'));
      await assert.rejects(() => M.searchContent({ type: 'mod', mc: '1.21.1' }), /Неизвестный тип/);
      const ins = await M.installContent({ root, versionId: prof, project: 'SHD', type: 'shader', title: 'BSL' });
      assert.strictEqual(ins.filename, 'BSL_8.0.zip');
      assert.ok(fs.existsSync(path.join(P.instance(prof), 'shaderpacks', 'BSL_8.0.zip')), 'берётся релиз, а не бета');
      assert.strictEqual((await M.listContent({ root, versionId: prof, type: 'shader' })).length, 1);
      await assert.rejects(() => M.removeContent({ root, versionId: prof, type: 'shader', filename: '../../x.zip' }), /Небезопасное имя/);
      await M.removeContent({ root, versionId: prof, type: 'shader', filename: 'BSL_8.0.zip' });
      assert.strictEqual((await M.listContent({ root, versionId: prof, type: 'shader' })).length, 0);
    } finally { globalThis.fetch = realFetch; srv.close(); }
  });

  await t('серверы: ping (Server List Ping) и список избранного', async () => {
    const net2 = require('net');
    const { ping, packet, varint } = src('multiplayer/ping');
    let hsHost = '';
    const srv = net2.createServer((c) => {
      c.on('data', (d) => {
        // рукопожатие: len, id=0, protocol varint, строка адреса (len+bytes), порт, next=1
        if (!hsHost) { const l = d[4]; hsHost = d.toString('utf8', 5, 5 + l); }
        const json = Buffer.from(JSON.stringify({ version: { name: '§aPaper 1.21', protocol: 767 }, players: { online: 3, max: 20 }, description: { text: 'Привет', extra: [{ text: ' §6мир' }] } }));
        c.write(packet(0, Buffer.concat([varint(json.length), json])));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const r = await ping({ host: '127.0.0.1', port });
    srv.close();
    assert.ok(r.online);
    assert.deepStrictEqual(r.players, { online: 3, max: 20 });
    assert.strictEqual(r.version, 'Paper 1.21');
    assert.strictEqual(r.motd, 'Привет мир');
    assert.strictEqual(hsHost, '127.0.0.1');
    assert.strictEqual((await ping({ host: 'bad host!', port: 25565 })).online, false);
    const closed = await ping({ host: '127.0.0.1', port, timeoutMs: 800 });
    assert.strictEqual(closed.online, false);

    const { normalize, DEFAULTS } = src('settings/settings');
    const st = normalize({ serverList: [
      { name: 'A', host: 'play.a.com', port: 25565 }, { name: 'dup', host: 'PLAY.a.com', port: '25565' },
      { name: 'bad', host: 'a b', port: 1 }, { host: 'b.net', port: 99999 }, 5,
    ] }, DEFAULTS());
    assert.deepStrictEqual(st.serverList.map((x) => `${x.name}|${x.host}|${x.port}`), ['A|play.a.com|25565', 'b.net|b.net|65535']);
  });

  await t('stats: время игры по сборкам', () => {
    const { Stats } = src('stats/stats');
    const f = path.join(tmp, 'stats-test.json');
    const st = new Stats(f);
    st.record('a', 3000); // слишком коротко — запуск считается, время нет
    st.record('a', 60000 * 30);
    st.record('b', 60000 * 90);
    const g = new Stats(f).get(); // перечитывается с диска
    assert.deepStrictEqual(g.rows.map((r) => r.id), ['b', 'a']);
    assert.strictEqual(g.rows[1].launches, 2);
    assert.strictEqual(g.rows[1].playMs, 60000 * 30);
    assert.strictEqual(g.totalMs, 60000 * 120);
    st.forget('a');
    assert.strictEqual(st.get().rows.length, 1);
  });

  await t('обновления лаунчера: сравнение версий и разбор релиза; тема и репозиторий в настройках', async () => {
    const U = src('updates');
    assert.ok(U.compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(U.compareVersions('v1.4.0', '1.4.0') === 0);
    assert.ok(U.compareVersions('1.4.0-beta', '1.4.1') < 0);
    const realFetch = globalThis.fetch;
    let reply;
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, opts);
      return reply();
    };
    try {
      reply = () => new Response(JSON.stringify({ tag_name: 'v1.5.0', html_url: 'https://github.com/o/r/releases/tag/v1.5.0', body: 'Новое', prerelease: false }), { status: 200 });
      const r = await U.check({ repo: 'o/r', current: '1.4.0' });
      assert.ok(r.available);
      assert.strictEqual(r.version, '1.5.0');
      reply = () => new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://evil.example/x' }), { status: 200 });
      const same = await U.check({ repo: 'o/r', current: '1.4.0' });
      assert.ok(!same.available && /^https:\/\/github\.com\//.test(same.url));
      reply = () => new Response('{}', { status: 404 });
      assert.strictEqual((await U.check({ repo: 'o/r', current: '1.4.0' })).reason, 'no-releases');
      assert.strictEqual((await U.check({ repo: 'не репо', current: '1.4.0' })).available, false);
    } finally { globalThis.fetch = realFetch; }
    const { normalize, DEFAULTS } = src('settings/settings');
    const s1 = normalize({ theme: 'light', updateRepo: 'a/b' }, DEFAULTS());
    assert.strictEqual(s1.theme, 'light');
    assert.strictEqual(s1.updateRepo, 'a/b');
    assert.strictEqual(normalize({ theme: 'neon', updateRepo: 'bad repo' }, s1).theme, 'light');
    assert.strictEqual(normalize({ updateRepo: 'bad repo' }, s1).updateRepo, 'a/b');
    assert.strictEqual(normalize({ updateRepo: '' }, s1).updateRepo, '');
  });

  await t('CurseForge: ключ только из настроек, поиск, установка с зависимостями, запрет скачивания', async () => {
    const crypto = require('crypto');
    const M = src('market/market');
    const CF = src('market/curseforge');
    const { gamePaths } = src('core/paths');
    const { normalize, DEFAULTS } = src('settings/settings');
    assert.strictEqual(normalize({ curseforgeKey: 'bad key!' }, DEFAULTS()).curseforgeKey, '');
    const KEY = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    assert.strictEqual(normalize({ curseforgeKey: KEY }, DEFAULTS()).curseforgeKey, KEY);
    await assert.rejects(() => M.search({ source: 'curseforge', mc: '1.20.1', kind: 'forge' }), /Не указан ключ/);

    const root = path.join(tmp, 'cfgame');
    const P = gamePaths(root);
    const prof = '1.20.1-forge-47.4.28';
    fs.mkdirSync(P.versionDir(prof), { recursive: true });
    fs.writeFileSync(P.versionJson(prof), JSON.stringify({ id: prof, inheritsFrom: '1.20.1', type: 'release' }));
    fs.mkdirSync(P.versionDir('1.20.1'), { recursive: true });
    fs.writeFileSync(P.versionJson('1.20.1'), JSON.stringify({ id: '1.20.1', type: 'release' }));

    const jar = crypto.randomBytes(2000);
    const sha = crypto.createHash('sha1').update(jar).digest('hex');
    const srv = require('http').createServer((q, s2) => s2.end(jar));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const realFetch = globalThis.fetch; const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.startsWith('https://api.curseforge.com/v1/')) return realFetch(url, opts);
      seen.push({ u: decodeURIComponent(u), key: opts && opts.headers && opts.headers['x-api-key'] });
      const json = (o) => new Response(JSON.stringify(o), { status: 200 });
      if (u.includes('/mods/search')) return json({ pagination: { totalCount: 1, index: 0 }, data: [{ id: 111, slug: 'jei', name: 'JEI', summary: 'd', downloadCount: 5, authors: [{ name: 'mezz' }], categories: [{ name: 'Utility' }], logo: { thumbnailUrl: 'https://evil.example/x.png' } }] });
      if (/\/mods\/111\/files/.test(u)) return json({ data: [{ fileName: 'jei-1.jar', displayName: 'jei 1', fileDate: '2026-01-01', releaseType: 1, downloadUrl: `${base}/j`, fileLength: jar.length, hashes: [{ algo: 1, value: sha }], dependencies: [{ modId: 222, relationType: 3 }, { modId: 333, relationType: 2 }] }] });
      if (/\/mods\/222\/files/.test(u)) return json({ data: [{ fileName: 'lib.jar', displayName: 'lib', fileDate: '2026-01-01', releaseType: 1, downloadUrl: null, hashes: [], dependencies: [] }] });
      if (/\/mods\/\d+$/.test(u)) return json({ data: { name: u.endsWith('111') ? 'JEI' : 'LibMod' } });
      return new Response('{}', { status: 404 });
    };
    CF.hooks.allowHost = (u) => u.startsWith('http://127.0.0.1') || /forgecdn\.net/.test(u);
    try {
      const r = await M.search({ source: 'curseforge', query: 'jei', mc: '1.20.1', kind: 'forge', curseforgeKey: KEY });
      assert.strictEqual(r.hits[0].id, '111');
      assert.strictEqual(r.hits[0].icon, '', 'чужие картинки отбрасываются');
      assert.ok(seen[0].u.includes('modLoaderType=1') && seen[0].u.includes('gameVersion=1.20.1') && seen[0].u.includes('classId=6'));
      assert.strictEqual(seen[0].key, KEY);
      const ins = await M.install({ root, versionId: prof, project: '111', title: 'JEI', source: 'curseforge', curseforgeKey: KEY });
      assert.strictEqual(ins.installed.length, 1);
      assert.ok(fs.readFileSync(path.join(P.instance(prof), 'mods', 'jei-1.jar')).equals(jar));
      assert.ok(ins.skipped.some((x) => /запретил скачивание/.test(x.reason)), 'мод без downloadUrl пропущен с пояснением');
      const mf = JSON.parse(fs.readFileSync(path.join(P.instance(prof), 'mods', '.ewl-market.json'), 'utf8'));
      assert.strictEqual(mf.mods[0].source, 'curseforge');
      assert.deepStrictEqual(await M.checkUpdates({ root, versionId: prof }), [], 'обновления CurseForge-модов пока не проверяются');
    } finally { globalThis.fetch = realFetch; CF.hooks.allowHost = null; srv.close(); }
  });

  await t('Discord Rich Presence: рукопожатие, активность, очистка, тихий отказ без Discord', async () => {
    const net3 = require('net');
    const { DiscordPresence, OP } = src('discord');
    // На Windows сокет — это именованный канал, на Linux/macOS — файл.
    const ipc = (name) => (process.platform === 'win32' ? `\\\\.\\pipe\\ewl-test-${process.pid}-${name}` : path.join(tmp, name));
    const sockPath = ipc('discord-ipc-0');
    const got = [];
    const srv = net3.createServer((c) => {
      let buf = Buffer.alloc(0);
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const op = buf.readUInt32LE(0); const len = buf.readUInt32LE(4);
          if (buf.length < 8 + len) break;
          const msg = JSON.parse(buf.toString('utf8', 8, 8 + len));
          buf = buf.subarray(8 + len);
          got.push({ op, msg });
          if (op === OP.HANDSHAKE) {
            const body = Buffer.from(JSON.stringify({ cmd: 'DISPATCH', evt: 'READY', data: {} }));
            const head = Buffer.alloc(8); head.writeUInt32LE(OP.FRAME, 0); head.writeUInt32LE(body.length, 4);
            c.write(Buffer.concat([head, body]));
          }
        }
      });
    });
    await new Promise((r) => srv.listen(sockPath, r));
    const pr = new DiscordPresence({ clientId: '1566921266429165568', pipes: [ipc('no-such-pipe'), sockPath] });
    assert.strictEqual(await pr.set({ details: 'Играет в Minecraft', state: 'Моя сборка', startedAt: 1730000000000 }), true);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(got[0].msg.client_id, '1566921266429165568');
    const act = got.find((g) => g.msg.cmd === 'SET_ACTIVITY');
    assert.ok(act, 'активность отправлена сразу после READY');
    assert.strictEqual(act.msg.args.activity.state, 'Моя сборка');
    assert.strictEqual(act.msg.args.activity.timestamps.start, 1730000000);
    await pr.clear();
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(got.filter((g) => g.msg.cmd === 'SET_ACTIVITY').pop().msg.args.activity, null);
    pr.close(); srv.close();
    // Discord не запущен: без ошибок, просто false
    const none = new DiscordPresence({ clientId: '1566921266429165568', pipes: [ipc('none-1'), ipc('none-2')] });
    assert.strictEqual(await none.set({ details: 'x' }), false);
    assert.strictEqual(await new DiscordPresence({ clientId: 'abc', pipes: [] }).connect(), false);
  });

  console.log(`\n${passed} тестов пройдено`);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
