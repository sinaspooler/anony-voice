// Session heartbeat, run from a Web Worker: worker timers are exempt from the
// aggressive timer throttling browsers apply to background tabs, so a caller
// who switches tabs mid-call keeps heartbeating instead of being dropped.
let apiUrl = null;
let memberId = null;
let memberSecret = null;
let timer = null;

onmessage = (e) => {
  const d = e.data || {};
  if (d.cmd === 'start') {
    apiUrl = d.apiUrl;
    memberId = d.memberId;
    memberSecret = d.memberSecret;
    const interval = d.interval || 3000;
    if (!timer) timer = setInterval(beat, interval);
  } else if (d.cmd === 'stop' && timer) {
    clearInterval(timer);
    timer = null;
  }
};

function beat() {
  fetch(apiUrl + '?action=heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, memberSecret }),
  }).catch(() => {});
}
