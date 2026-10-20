(function () {
  'use strict';

  const ROOT = 'intent-benchmark';
  let session = null;

  function encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  function decode(value) {
    const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function pathUrl(path) {
    if (!session) throw new Error('请先连接私有仓库。');
    if (!path.startsWith(ROOT + '/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('数据路径不合法。');
    }
    return 'https://api.github.com/repos/' + encodeURIComponent(session.owner) + '/' + encodeURIComponent(session.repo) + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  }

  function repoUrl(suffix = '') {
    if (!session) throw new Error('请先连接私有仓库。');
    return 'https://api.github.com/repos/' + encodeURIComponent(session.owner) + '/' + encodeURIComponent(session.repo) + suffix;
  }

  async function request(url, options = {}) {
    if (!session) throw new Error('请先连接私有仓库。');
    const { raw = false, ...fetchOptions } = options;
    const response = await fetch(url, {
      ...fetchOptions,
      cache: 'no-store',
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: 'Bearer ' + session.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    if (response.status === 204) return null;
    const body = await response.text();
    const data = raw && response.ok ? body : (() => { try { return JSON.parse(body); } catch (_) { return {}; } })();
    if (!response.ok) {
      const details = response.status === 401 ? '令牌无效或已过期。'
        : response.status === 403 ? '权限不足或 GitHub 暂时拒绝访问。'
          : response.status === 409 || response.status === 422 ? '数据已在别处更新，请重新载入后再试。'
            : response.status === 404 ? '找不到仓库或数据文件。'
              : 'GitHub 返回 HTTP ' + response.status + '：' + (data.message || '请求失败');
      const error = new Error(details);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  window.WorkflowStore = {
    async connect(owner, repo, token) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || !token) {
        throw new Error('请填写正确的私有仓库名称和令牌。');
      }
      session = { owner, repo, token };
      try {
        const metadata = await request(repoUrl());
        if (!metadata.private) throw new Error('题库仓库必须是私有仓库。');
        return await this.readJson(ROOT + '/state.json');
      } catch (error) {
        session = null;
        throw error;
      }
    },
    async readJson(path) {
      try {
        const file = await request(pathUrl(path));
        if (file.type !== 'file') throw new Error('数据文件格式不受支持：' + path);
        const data = typeof file.content === 'string' && file.content.trim() ? decode(file.content)
          : JSON.parse(await request(pathUrl(path), { raw: true }));
        return { data, sha: file.sha };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    async list(path) {
      try {
        const files = await request(pathUrl(path));
        if (!Array.isArray(files)) throw new Error('目录格式不受支持：' + path);
        return files;
      } catch (error) {
        if (error.status === 404) return [];
        throw error;
      }
    },
    async writeJson(path, data, sha = null) {
      const body = { message: 'Save intent evaluation: ' + path, content: encode(data) };
      if (sha) body.sha = sha;
      const result = await request(pathUrl(path), { method: 'PUT', body: JSON.stringify(body) });
      return result.content.sha;
    },
    async dispatchRun(runId) {
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId)) throw new Error('运行 ID 不合法。');
      return request(repoUrl('/dispatches'), {
        method: 'POST',
        body: JSON.stringify({ event_type: 'intent_benchmark_run', client_payload: { run_id: runId } })
      });
    },
    disconnect() { session = null; },
    isConnected() { return Boolean(session); },
    repository() { return session ? session.owner + '/' + session.repo : ''; }
  };
})();
