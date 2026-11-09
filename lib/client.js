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

    function statusColor(connected) {
      if (connected === true) return '#2ea043';
      // Not connected is the normal state, not an alarm: light grey, not red.
      if (connected === false) return 'rgba(160,160,160,.85)';
      return 'rgba(128,128,128,.45)';
    }

    function formatRemaining(ms) {
      const minutes = Math.max(0, Math.round(ms / 60000));
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return hours > 0 ? `${hours}h${rest < 10 ? '0' : ''}${rest}m` : `${rest}m`;
    }

    /**
     * 轮询 /api/state 并汇总所有会话：只要有一个连着就算在线，剩余时间取其中最大的。
     * 打开弹窗时勤一点，收起时 60 秒足够，也免得频繁拉起 WSL。
     */
    function useClusterStatus(active) {
      const [info, setInfo] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          // A hidden tab does not need to wake WSL every minute.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          fetch(BASE + '/api/state', { cache: 'no-store' })
            .then((r) => r.json())
            .then((s) => {
              if (!alive) return;
              const sessions = Array.isArray(s.sessions) ? s.sessions : [];
              const live = sessions.filter((x) => x && x.master);
              const remaining = live.reduce((max, x) => Math.max(max, Number(x.remainingMs) || 0), 0);
              setInfo({ connected: live.length > 0, remaining });
            })
            .catch(() => { if (alive) setInfo({ connected: false, remaining: 0 }); });
        };
        load();
        const timer = setInterval(load, active ? POLL_MS : 60000);
        return () => { alive = false; clearInterval(timer); };
      }, [active]);
      return info;
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
      const info = useClusterStatus(open);
      const connected = info ? info.connected : undefined;
      const color = statusColor(connected);
      const remaining = info && info.connected && info.remaining > 0 ? formatRemaining(info.remaining) : '';
      const label = wide ? (remaining ? `${LABEL} · ${remaining}` : LABEL) : '';
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          style: wide ? style.trigger : Object.assign({}, style.trigger, style.triggerRail),
          title: connected === false ? '未连接' : (remaining ? `已连接，还剩 ${remaining}` : LABEL),
          'aria-label': remaining ? `${LABEL}，还剩 ${remaining}` : LABEL,
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        },
          h(Icon),
          wide ? h('span', null, label) : null,
          h('span', {
            style: wide ? Object.assign({}, style.dot, { background: color }) : Object.assign({}, style.dot, style.dotRail, { background: color }),
            title: connected === true ? '已连接' : (connected === false ? '未连接' : '查询中'),
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
