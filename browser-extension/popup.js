
const BRIDGE = 'http://localhost:7432';

const apiTokenInput = document.getElementById('apiToken');
const saveBtn = document.getElementById('saveBtn');
const savedMsg = document.getElementById('savedMsg');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const checkBtn = document.getElementById('checkBtn');

chrome.storage.sync.get(['apiToken'], ({ apiToken }) => 
{
  if (apiToken)
  {
    apiTokenInput.value = apiToken;
    apiTokenInput.type  = 'password';
  }
});

saveBtn.addEventListener('click', () =>
{
  const token = apiTokenInput.value.trim();
  if (!token)
  {
    flash(savedMsg, 'Please paste your API token first', '#e67e22');
    return;
  }
  chrome.storage.sync.set({ apiToken: token }, () => {
    flash(savedMsg, 'Token saved!', '#2ecc71');
  });
});

apiTokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

checkBtn.addEventListener('click', checkBridge);

async function checkBridge() 
{
  statusText.textContent = 'Checking…';
  statusDot.className = 'status-dot';

  try 
  {
    const resp = await fetch(`${BRIDGE}/status`, { method: 'GET' });
    const data = await resp.json();
    if (data.status === 'running')
    {
      statusDot.classList.add('online');
      statusText.textContent = 'Online ✅';
    } else
    {
      throw new Error('Unexpected response');
    }
  } catch 
  {
    statusDot.classList.add('offline');
    statusText.textContent = 'Offline — start bridge_server.py';
  }
}

checkBridge();

function flash(el, msg, color)
{
  el.textContent = msg;
  el.style.color = color;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
}
