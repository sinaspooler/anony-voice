// Session heartbeat, run from a Web Worker: worker timers are exempt from the
// aggressive timer throttling browsers apply to background tabs, so a caller
// who switches tabs mid-call keeps heartbeating instead of being dropped.
let clientId = null;
let timer = null;

onmessage = (e) => {
  const d = e.data || {};
  if (d.cmd === 'start') {
    clientId = d.clientId;
    if (!timer) timer = setInterval(beat, 3000);
  } else if (d.cmd === 'stop' && timer) {
    clearInterval(timer);
    timer = null;
  }
};

function beat() {
  fetch('api.php?action=heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  }).catch(() => {});
}
