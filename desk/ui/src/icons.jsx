// The canvas's icons: Lucide's, node for node as the canvas's own Lucide build draws them
// (docs/design/DS-691/project/index.html), 24-unit grid, 2-unit stroke in currentColor.
const NODES = {
  inbox: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
    ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  'folder-git-2': [['path', { d: 'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5' }],
    ['circle', { cx: '13', cy: '12', r: '2' }], ['path', { d: 'M18 19c-2.8 0-5-2.2-5-5v8' }], ['circle', { cx: '20', cy: '19', r: '2' }]],
  'arrow-up-right': [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  gauge: [['path', { d: 'm12 14 4-4' }], ['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }]],
  pin: [['path', { d: 'M12 17v5' }],
    ['path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' }]],
  hourglass: [['path', { d: 'M5 22h14' }], ['path', { d: 'M5 2h14' }],
    ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
    ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }]],
  'circle-x': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
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
