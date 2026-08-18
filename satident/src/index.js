const PRIVATE_BASE = "http://10.64.7.8:8476";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const originUrl = new URL(url.pathname + url.search, PRIVATE_BASE);
    return env.MESH.fetch(originUrl.toString(), request);
  },
};
