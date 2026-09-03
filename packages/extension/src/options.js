const url = document.getElementById('url');
const saved = document.getElementById('saved');

chrome.storage.local.get({ sealUrl: 'http://localhost:4000' }).then((c) => {
  url.value = c.sealUrl;
});

document.getElementById('save').onclick = async () => {
  await chrome.storage.local.set({ sealUrl: url.value.trim().replace(/\/$/, '') });
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 2000);
};
