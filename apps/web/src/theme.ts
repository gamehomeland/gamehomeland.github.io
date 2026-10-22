type Theme = 'light' | 'dark';
const STORAGE_KEY = 'homeland-theme';

export function installTheme(button: HTMLButtonElement): void {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference: Theme | undefined;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // 离线文件或隐私设置可能禁用存储，当前窗口仍可切换主题。
  }
  const apply = (theme: Theme) => {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? '日间模式' : '夜间模式';
    button.textContent = next;
    button.setAttribute('aria-label', `切换到${next}`);
    button.title = `当前为${theme === 'dark' ? '夜间' : '日间'}模式`;
  };
  apply(preference ?? (system.matches ? 'dark' : 'light'));
  button.addEventListener('click', () => {
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // 存储不可用不影响使用与导出。
    }
  });
  system.addEventListener('change', () => {
    if (!preference) apply(system.matches ? 'dark' : 'light');
  });
}
