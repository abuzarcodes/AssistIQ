/**
 * AssistIQ floating chat widget loader (CP-11.8).
 *
 *   <script src="https://chat.example.com/widget/loader.js"
 *           data-deployment-id="<deployment-id>" async defer></script>
 *
 * Owns a small fixed frame pointed at the embed page (`?mode=widget`), which
 * renders the launcher and the panel. Sizing and positioning arrive by
 * postMessage from that page (`ready`, `position`, `resize`, `state`), so this
 * file never fetches configuration and stays tiny.
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();
  var deploymentId = script && script.getAttribute('data-deployment-id');
  if (!deploymentId || !script || !script.src) return;

  var base = script.src.replace(/\/widget\/loader\.js.*$/, '');
  var NAMESPACE = '__assistiqWidgets';

  // A second paste of the snippet replaces the first rather than stacking frames.
  if (window[NAMESPACE] && window[NAMESPACE][deploymentId]) {
    window[NAMESPACE][deploymentId].destroy();
  }

  var container = document.createElement('div');
  container.setAttribute('data-assistiq-widget', deploymentId);
  container.style.cssText =
    'position:fixed;z-index:2147483000;bottom:20px;right:20px;margin:0;padding:0;';

  var frame = document.createElement('iframe');
  frame.src = base + '/chat/embed/' + encodeURIComponent(deploymentId) + '?mode=widget';
  frame.title = 'Chat support';
  frame.setAttribute('allow', 'clipboard-write');
  frame.setAttribute('loading', 'lazy');
  frame.style.cssText =
    'border:0;width:230px;height:64px;max-width:calc(100vw - 32px);background:transparent;color-scheme:light dark;display:block;';
  container.appendChild(frame);

  function mount() {
    if (document.body) {
      document.body.appendChild(container);
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  }
  mount();

  function setPosition(position) {
    container.style.top = '';
    container.style.right = '';
    container.style.bottom = '';
    container.style.left = '';
    if (position === 'bottom-left') {
      container.style.bottom = '20px';
      container.style.left = '20px';
    } else if (position === 'top-right') {
      container.style.top = '20px';
      container.style.right = '20px';
    } else if (position === 'top-left') {
      container.style.top = '20px';
      container.style.left = '20px';
    } else {
      container.style.bottom = '20px';
      container.style.right = '20px';
    }
  }

  function onMessage(event) {
    var data = event.data;
    if (!data || data.source !== 'assistiq-widget') return;
    if (data.deploymentId !== deploymentId) return;

    if (data.type === 'position' && typeof data.position === 'string') {
      setPosition(data.position);
    } else if (
      data.type === 'resize' &&
      typeof data.width === 'number' &&
      typeof data.height === 'number' &&
      isFinite(data.width) &&
      isFinite(data.height)
    ) {
      frame.style.width = Math.max(0, Math.min(data.width, window.innerWidth - 16)) + 'px';
      frame.style.height = Math.max(0, Math.min(data.height, window.innerHeight - 16)) + 'px';
    }
  }

  window.addEventListener('message', onMessage);

  var api = {
    destroy: function () {
      window.removeEventListener('message', onMessage);
      if (container.parentNode) container.parentNode.removeChild(container);
      if (window[NAMESPACE]) delete window[NAMESPACE][deploymentId];
    },
  };

  window[NAMESPACE] = window[NAMESPACE] || {};
  window[NAMESPACE][deploymentId] = api;
})();
