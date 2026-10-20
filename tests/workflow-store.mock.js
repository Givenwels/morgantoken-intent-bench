(function () {
  'use strict';
  const storageKey = 'fictional-workflow-browser-test-v1';
  let files = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
  let connected = false;
  let repository = '';
  let sequence = Math.max(0, ...Object.values(files).map((entry) => Number(entry.sequence) || 0));
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function persist() { sessionStorage.setItem(storageKey, JSON.stringify(files)); }
  function requireConnection() { if (!connected) throw new Error('Mock repository is disconnected.'); }
  window.__mockWorkflowStore = true;
  window.WorkflowStore = {
    async connect(owner, repo, token) {
      if (token !== 'FAKE_PAT') throw new Error('Use the fictional FAKE_PAT in this test.');
      repository = owner + '/' + repo;
      connected = true;
      return this.readJson('intent-benchmark/state.json');
    },
    async readJson(file) {
      requireConnection();
      return files[file] ? { data: copy(files[file].data), sha: files[file].sha } : null;
    },
    async list(directory) {
      requireConnection();
      const prefix = directory + '/';
      const entries = new Map();
      for (const filename of Object.keys(files)) {
        if (!filename.startsWith(prefix)) continue;
        const remainder = filename.slice(prefix.length);
        const name = remainder.split('/')[0];
        entries.set(name, { name, type: remainder.includes('/') ? 'dir' : 'file' });
      }
      return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async writeJson(file, data, expectedSha) {
      requireConnection();
      const previous = files[file];
      if ((previous?.sha || null) !== (expectedSha || null)) throw new Error('Mock SHA conflict.');
      sequence++;
      const sha = 'mock-sha-' + sequence;
      files[file] = { data: copy(data), sha, sequence };
      persist();
      return sha;
    },
    async dispatchRun() { throw new Error('API dispatch is unavailable in this fictional test.'); },
    disconnect() { connected = false; },
    isConnected() { return connected; },
    repository() { return repository; }
  };
})();
