// URLパラメータをチェックし、チャットパネルの初期表示を制御
const urlParams = new URLSearchParams(window.location.search);
window.isChatHiddenOnLoad = urlParams.get('chat') === 'hidden';
window.isChatFullscreenOnLoad = urlParams.get('chat') === 'fullscreen';

document.addEventListener('DOMContentLoaded', () => {
  const chatPanel = document.getElementById('chatPanel');
  const chatOpenBtn = document.getElementById('chatOpenBtn');
  const resizer = document.getElementById('resizer');
  const leftColumn = document.getElementById('leftColumn');
  const fullscreenToggleBtn = document.getElementById('fullscreenToggle');

  if (window.isChatHiddenOnLoad) {
    chatPanel.style.display = 'none';
    chatOpenBtn.style.display = 'block';
    resizer.style.display = 'none';
    leftColumn.style.flex = '1 1 100%';
  } else if (window.isChatFullscreenOnLoad) {
    chatPanel.style.display = 'flex';
    chatOpenBtn.style.display = 'none';
    resizer.style.display = 'none'; // フルスクリーン時はリサイザーも非表示
    leftColumn.style.display = 'none'; // 左カラムを非表示
    chatPanel.style.flex = '1 1 100%';
    chatPanel.style.maxWidth = '100%';
    chatPanel.style.flexBasis = '100%';
    fullscreenToggleBtn.textContent = '↙'; // フルスクリーンアイコンに変更
  } else {
    chatPanel.style.display = 'flex';
    chatOpenBtn.style.display = 'none';
    resizer.style.display = '';
    // leftColumnのflexはCSSで設定されているデフォルト値を使用
  }
});
