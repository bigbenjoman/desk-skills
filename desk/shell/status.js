// The card Desk.app shows before the desk-ui server's page can: ?state=unreachable|signed-out.
const q = new URLSearchParams(location.search);
const state = q.get('state') === 'signed-out' ? 'signed-out' : 'unreachable';
document.getElementById(state).hidden = false;

const from = q.get('checkout');
if (from) document.getElementById('install-cmd').textContent = `cd ${from} && ./install.sh`;

for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.previousElementSibling.textContent).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    }, () => {});
  });
}

if (state === 'unreachable') {
  const attempt = Number(q.get('attempt')) || 1;
  let left = Number(q.get('retry')) || 5;
  const line = document.getElementById('countdown');
  const draw = () => { line.textContent = left > 0 ? `Trying again in ${left} s… (attempt ${attempt})` : 'Trying again…'; };
  draw();
  setInterval(() => { if (left > 0) { left -= 1; draw(); } }, 1000);
  document.getElementById('retry').addEventListener('click', () => {
    left = 0; draw();
    window.desk?.retryNow();
  });
}
