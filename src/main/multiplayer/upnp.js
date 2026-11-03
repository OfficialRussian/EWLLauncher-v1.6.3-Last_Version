'use strict';
/**
 * UPnP IGD: автоматический проброс TCP-порта на домашнем роутере (без сторонних сервисов).
 * SSDP-поиск шлюза -> описание устройства -> SOAP-вызовы AddPortMapping / DeletePortMapping / GetExternalIPAddress.
 */
const dgram = require('dgram');

class UpnpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpnpError';
    this.code = code;
  }
}

const ST_LIST = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'upnp:rootdevice',
];
const WAN_RE = /:service:(WANIPConnection|WANPPPConnection):\d/;

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function discoverLocations(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch (_) { /* уже закрыт */ }
      resolve([...found]);
    };
    sock.on('error', finish);
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) found.add(m[1].trim());
    });
    sock.bind(0, () => {
      for (const st of ST_LIST) {
        const req = Buffer.from([
          'M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', '',
        ].join('\r\n'));
        sock.send(req, 1900, '239.255.255.250', () => {});
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

function parseServices(xml, location) {
  const baseMatch = /<URLBase>([^<]+)<\/URLBase>/i.exec(xml);
  const base = baseMatch ? baseMatch[1].trim() : location;
  const services = [];
  const re = /<service>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const type = /<serviceType>([^<]+)</i.exec(m[1]);
    const ctl = /<controlURL>([^<]+)</i.exec(m[1]);
    if (type && ctl) {
      try { services.push({ type: type[1].trim(), controlUrl: new URL(ctl[1].trim(), base).toString() }); } catch (_) { /* кривой URL */ }
    }
  }
  return services;
}

function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', (e) => { try { s.close(); } catch (_) { /* */ } reject(e); });
    s.connect(1900, host, () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
}

class Gateway {
  constructor({ location, serviceType, controlUrl }) {
    this.location = location;
    this.serviceType = serviceType;
    this.controlUrl = controlUrl;
  }

  async soap(action, args = {}) {
    const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
    const body = '<?xml version="1.0"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + `<s:Body><u:${action} xmlns:u="${this.serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(this.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${this.serviceType}#${action}"` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) {
      const code = /<errorCode>(\d+)</.exec(text);
      const desc = /<errorDescription>([^<]*)</.exec(text);
      throw new UpnpError(code ? Number(code[1]) : res.status, desc ? desc[1] : `HTTP ${res.status}`);
    }
    return text;
  }

  async getExternalIP() {
    const t = await this.soap('GetExternalIPAddress');
    const m = /<NewExternalIPAddress>([^<]*)</.exec(t);
    return m ? m[1].trim() : '';
  }

  async addMapping({ externalPort, internalPort, internalClient, description, leaseSec }) {
    await this.soap('AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: externalPort,
      NewProtocol: 'TCP',
      NewInternalPort: internalPort,
      NewInternalClient: internalClient,
      NewEnabled: 1,
      NewPortMappingDescription: description,
      NewLeaseDuration: leaseSec,
    });
  }

  async deleteMapping(externalPort) {
    await this.soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP' });
  }

  localAddress() {
    return localAddressFor(new URL(this.controlUrl).hostname);
  }
}

/** Ищет роутер с UPnP. Возвращает Gateway или null. */
async function discoverGateway(timeoutMs = 2500) {
  const locations = await discoverLocations(timeoutMs);
  for (const loc of locations) {
    try {
      const res = await fetch(loc, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const services = parseServices(await res.text(), loc);
      const wan = services.find((s) => WAN_RE.test(s.type));
      if (wan) return new Gateway({ location: loc, serviceType: wan.type, controlUrl: wan.controlUrl });
    } catch (_) { /* пробуем следующий */ }
  }
  return null;
}

module.exports = { discoverGateway, parseServices, Gateway, UpnpError };
