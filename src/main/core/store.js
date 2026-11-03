'use strict';
/** JSON-хранилище с атомарной записью (tmp + rename) и резервной копией при повреждении файла. */
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = JSON.parse(JSON.stringify(defaults));
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...JSON.parse(JSON.stringify(this.defaults)), ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(this.file, `${this.file}.corrupt`); } catch (_) { /* нечего копировать */ }
      }
      this.data = JSON.parse(JSON.stringify(this.defaults));
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
