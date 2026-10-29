/**
 * dsh-pku-cluster — 客户端部分
 *
 * 在侧边栏页脚（`sidebar.footer.action`）注册一个「连接集群」按钮，
 * 就排在「移动访问」旁边。点开后是一个弹窗，内嵌宿主插件已经提供的
 * 登录页（/plugins/dsh-pku-cluster/），所以密码/OTP 表单、状态、
 * 断开逻辑都复用那一份，不在这里重复实现。
 *
 * 按钮上带一个状态点：绿=已连接，红=未连接，灰=查询中。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pku-cluster',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const BASE = '/plugins/dsh-pku-cluster';
    const LABEL = '连接集群';
    const POLL_MS = 15000;

    const style = {
      trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 8px',
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      },
      triggerRail: {
        justifyContent: 'center',
        padding: '6px 0',
      },
      dot: {
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        flex: 'none',
        marginLeft: 'auto',
      },
      dotRail: { position: 'absolute', top: '4px', right: '4px', marginLeft: 0 },
      overlay: {
        position: 'fixed',
        inset: '0',
        zIndex: 60,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      },
      dialog: {
        position: 'relative',
        width: 'min(560px, 100%)',
        height: 'min(620px, 100%)',
        borderRadius: '14px',
        overflow: 'hidden',
        background: 'Canvas',
        color: 'CanvasText',
        boxShadow: '0 18px 48px rgba(0,0,0,.35)',
        border: '1px solid rgba(128,128,128,.35)',
      },
      frame: { width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' },
      close: {
        position: 'absolute',
        top: '8px',
        right: '8px',
        zIndex: 2,
        width: '28px',
        height: '28px',
        lineHeight: '26px',
        padding: '0',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,.45)',
        background: 'Canvas',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '16px',
      },
    };

    function statusColor(master) {
      if (master === true) return '#2ea043';
      if (master === false) return '#d1242f';
      return 'rgba(128,128,128,.6)';
    }

    /** 轮询宿主插件的状态接口；按钮和弹窗共用。 */
    function useClusterStatus(active) {
      const [master, setMaster] = React.useState(undefined);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch(BASE + '/api/status', { cache: 'no-store' })
            .then((r) => r.json())
            .then((s) => { if (alive) setMaster(Boolean(s && s.master)); })
            .catch(() => { if (alive) setMaster(false); });
        };
        load();
        if (!active) return () => { alive = false; };
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [active]);
      return master;
    }

    function Icon() {
      return h('svg', {
        'aria-hidden': true,
        focusable: false,
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('rect', { x: 2, y: 3, width: 12, height: 4.5, rx: 1.2 }),
        h('rect', { x: 2, y: 8.5, width: 12, height: 4.5, rx: 1.2 }),
        h('path', { d: 'M4.6 5.25h.01M4.6 10.75h.01' }),
      );
    }

    function Dialog({ onClose }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', {
        style: style.overlay,
        role: 'presentation',
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { style: style.dialog, role: 'dialog', 'aria-label': LABEL },
          h('button', {
            type: 'button',
            style: style.close,
            'aria-label': '关闭',
            onClick: onClose,
          }, '×'),
          h('iframe', {
            style: style.frame,
            src: BASE + '/',
            title: LABEL,
          }),
        ),
      );
    }

    function ClusterAction({ wide }) {
      const [open, setOpen] = React.useState(false);
      const master = useClusterStatus(open);
      const color = statusColor(master);
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          style: wide ? style.trigger : Object.assign({}, style.trigger, style.triggerRail),
          title: LABEL,
          'aria-label': LABEL,
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        },
          h(Icon),
          wide ? h('span', null, LABEL) : null,
          h('span', {
            style: wide ? Object.assign({}, style.dot, { background: color }) : Object.assign({}, style.dot, style.dotRail, { background: color }),
            title: master ? '已连接' : '未连接',
          }),
        ),
        open ? h(Dialog, { onClose: () => setOpen(false) }) : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-pku-cluster' }, ClusterAction),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
