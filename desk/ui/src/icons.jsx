// The canvas's icons: Lucide's, node for node as the canvas's own Lucide build draws them
// (docs/design/DS-691/project/index.html), 24-unit grid, 2-unit stroke in currentColor.
const NODES = {
  inbox: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
    ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  'folder-git-2': [['path', { d: 'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5' }],
    ['circle', { cx: '13', cy: '12', r: '2' }], ['path', { d: 'M18 19c-2.8 0-5-2.2-5-5v8' }], ['circle', { cx: '20', cy: '19', r: '2' }]],
  'arrow-up-right': [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
};

export function Icon({ name, size = 16, className = '' }) {
  const nodes = NODES[name];
  if (!nodes) return null;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {nodes.map(([Tag, attrs], i) => <Tag key={i} {...attrs} />)}
    </svg>
  );
}
