(function () {
  'use strict';
  const DATA_PATH = 'intent-benchmark/state.json';
  let connection = null;

  function base64Encode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function base64Decode(value) {
    const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function endpoint(owner, repo, suffix) {
    return 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + suffix;
  }
  async function request(url, token, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 401 ? '令牌无效或已过期。' : response.status === 403 ? '权限不足或 GitHub API 暂时拒绝访问。' : response.status === 404 ? '找不到仓库或数据文件。请检查仓库名与令牌权限。' : response.status === 409 ? '另一处已更新题库。请刷新后重新连接，再应用刚才的修改。' : 'GitHub 返回 HTTP ' + response.status + '：' + (data.message || '请求失败'));
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function dataUrl(owner, repo) {
    return endpoint(owner, repo, '/contents/' + DATA_PATH);
  }
  async function readFile(owner, repo, token) {
    try {
      const file = await request(dataUrl(owner, repo), token);
      if (file.type !== 'file' || typeof file.content !== 'string') throw new Error('题库文件格式不受支持。');
      const data = JSON.parse(base64Decode(file.content));
      if (!data || !Array.isArray(data.questions)) throw new Error('题库 JSON 格式不正确。');
      return { state: data, sha: file.sha };
    } catch (error) {
      if (error.status === 404) return { state: { nextId: 1, selectedId: null, questions: [] }, sha: null };
      throw error;
    }
  }
  window.GitHubStore = {
    async connect(owner, repo, token) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error('仓库所有者或仓库名称格式不正确。');
      if (!token) throw new Error('请输入 GitHub 令牌。');
      const metadata = await request(endpoint(owner, repo, ''), token);
      if (!metadata.private) throw new Error('数据仓库必须是私有仓库，当前连接已拒绝。');
      const result = await readFile(owner, repo, token);
      connection = { owner, repo, token, sha: result.sha };
      return result.state;
    },
    async save(state) {
      if (!connection) throw new Error('请先连接私有数据仓库。');
      const { owner, repo, token, sha } = connection;
      const body = { message: 'Save intent benchmark data', content: base64Encode(JSON.stringify({ format: 'morgan-intent-bench-v1', nextId: state.nextId, questions: state.questions }, null, 2)) };
      if (sha) body.sha = sha;
      const result = await request(dataUrl(owner, repo), token, { method: 'PUT', body: JSON.stringify(body) });
      connection.sha = result.content.sha;
    },
    disconnect() { connection = null; },
    async reload() {
      if (!connection) throw new Error('请先连接私有数据仓库。');
      const result = await readFile(connection.owner, connection.repo, connection.token);
      connection.sha = result.sha;
      return result.state;
    }
  };
})();
