(function () {
  'use strict';
  if (window.top !== window || location.origin !== 'https://digimonlegend.com' ||
      !(location.pathname === '/deepseek/')) return;
  const nonce = '__DEEPSEEK_NATIVE_NONCE__';
  const blobs = new Map();
  const waiting = new Map();
  let port;
  let sequence = 0;
  let busy = false;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });

  function receiveChannel(event) {
    if (event.data !== nonce || !event.ports || event.ports.length !== 1) return;
    window.removeEventListener('message', receiveChannel);
    port = event.ports[0];
    port.onmessage = function (reply) {
      try {
        const response = JSON.parse(reply.data);
        const pending = waiting.get(response.id);
        if (!pending) return;
        waiting.delete(response.id);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve();
        else pending.reject(new Error(response.error || '导出失败，请重试'));
      } catch (_) {}
    };
    port.start();
    readyResolve();
  }
  window.addEventListener('message', receiveChannel);

  function send(type, values) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('导出连接超时，请刷新页面后重试'));
      }, 30000);
      waiting.set(id, { resolve, reject, timer });
      port.postMessage(JSON.stringify(Object.assign({ id, type }, values)));
    });
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('读取导出文件失败'));
      reader.readAsDataURL(blob);
    });
  }

  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = createObjectURL(blob);
    if (blob instanceof Blob) blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(String(url));
    return revokeObjectURL(url);
  };

  function download(url, name) {
    if (!String(url).startsWith('blob:https://digimonlegend.com/')) return false;
    if (busy) { alert('请先完成当前文件导出'); return true; }
    busy = true;
    // Capture the Blob before the site's synchronous revokeObjectURL call.
    const blobPromise = blobs.has(url)
      ? Promise.resolve(blobs.get(url))
      : fetch(url).then(response => response.blob());
    (async function () {
      let started = false;
      try {
        const blob = await blobPromise;
        let mime = (blob.type || '').split(';')[0].toLowerCase();
        const formats = {
          'application/zip': ['.zip', 'deepseek-history'],
          'text/markdown': ['.md', 'deepseek-conversation'],
          'text/plain': ['.txt', 'deepseek-conversation'],
          'application/json': ['.json', 'deepseek-conversation'],
          'image/png': ['.png', 'deepseek-image'],
          'image/jpeg': ['.jpg', 'deepseek-image'],
          'image/webp': ['.webp', 'deepseek-image'],
          'image/gif': ['.gif', 'deepseek-image']
        };
        // Older full-history exports use an empty or generic Blob type.
        if (/\.zip$/i.test(name) && (!mime || mime === 'application/octet-stream')) mime = 'application/zip';
        const format = formats[mime];
        if (!format) {
          throw new Error('不支持的导出文件类型');
        }
        name = name || format[1] + format[0];
        if (blob.size === 0 || blob.size > 128 * 1024 * 1024) {
          throw new Error('导出文件为空或超过 128 MB');
        }
        await Promise.race([ready, new Promise((_, reject) =>
          setTimeout(() => reject(new Error('导出尚未就绪，请刷新页面后重试')), 10000))]);
        await send('start', { name, mime, size: blob.size });
        started = true;
        for (let offset = 0; offset < blob.size; offset += 49152) {
          await send('chunk', { data: await base64(blob.slice(offset, offset + 49152)) });
        }
        await send('finish', {});
      } catch (error) {
        if (started && port) send('cancel', {}).catch(() => {});
        alert(error instanceof Error ? error.message : '导出失败，请重试');
      } finally {
        busy = false;
      }
    })();
    return true;
  }

  window.__deepseekNativeBlobDownload = download;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (download(this.href, this.download)) return;
    return click.call(this);
  };
  document.addEventListener('click', function (event) {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor && download(anchor.href, anchor.download)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const open = window.open;
  window.open = function (url, target, features) {
    if (url && download(String(url), '')) return null;
    return open.call(window, url, target, features);
  };
})();
