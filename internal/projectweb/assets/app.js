'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  let settings = {root: '~/herder-agent-code', default_project: '', projects: [], bypass: false};
  let selected = null;
  let mode = 'existing';
  let busy = false;
  let dirty = false;

  function notice(message, error = false) {
    const box = $('notice');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.setAttribute('role', error ? 'alert' : 'status');
    box.hidden = false;
  }

  async function api(path, method = 'GET', body) {
    const options = {method, mode: 'same-origin', credentials: 'omit', headers: {Accept: 'application/json'}};
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = csrf;
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    let result;
    try { result = await response.json(); } catch { throw new Error('无法读取服务响应，请确认本地服务仍在运行。'); }
    if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
    return result;
  }

  function elem(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderProjects() {
    $('project-count').textContent = settings.projects.length;
    const list = $('project-list');
    list.replaceChildren();
    if (!settings.projects.length) list.append(elem('p', 'empty-list', '还没有项目。关联已有目录，或创建一个新项目。'));
    for (const project of settings.projects) {
      const button = elem('button', 'project-item' + (selected === project.name ? ' active' : ''));
      button.type = 'button';
      button.setAttribute('aria-current', selected === project.name ? 'true' : 'false');
      button.disabled = busy;
      const title = elem('span', 'project-title');
      title.append(elem('span', 'project-name-text', project.name));
      if (settings.default_project === project.name) title.append(elem('span', 'default-badge', '默认'));
      const meta = elem('div', 'project-meta');
      meta.append(elem('span', '', project.agent === 'claude' ? 'Claude Code' : 'Codex'), elem('span', '', '·'), elem('span', '', project.directories.length + ' 个目录'));
      const path = elem('p', 'project-path', project.directories[0] || '');
      path.title = project.directories.join('\n');
      button.append(title, meta, path);
      button.addEventListener('click', () => { if (mayLeave()) openProject(project); });
      list.append(button);
    }
  }

  function mayLeave() {
    return !busy && (!dirty || window.confirm('当前更改尚未保存，确定离开？'));
  }

  function directories() {
    return [...$('directory-list').querySelectorAll('input')].map(input => input.value.trim());
  }

  function iconButton(text, label, action, disabled) {
    const button = elem('button', 'icon-button', text);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  function renderDirectories(values) {
    const list = $('directory-list');
    list.replaceChildren();
    values.forEach((value, index) => {
      const row = elem('div', 'directory-row');
      row.append(elem('span', 'directory-badge' + (index ? ' extra' : ''), index ? '附加 ' + index : '主目录'));
      const input = elem('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = index ? '~/code/another-repository' : '~/code/my-project';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.required = mode === 'existing';
      input.setAttribute('aria-label', index ? '附加目录 ' + index : '主目录');
      input.addEventListener('input', () => { dirty = true; });
      row.append(input);
      const actions = elem('div', 'directory-actions');
      const move = offset => {
        const current = directories();
        [current[index], current[index + offset]] = [current[index + offset], current[index]];
        dirty = true;
        renderDirectories(current);
        $('directory-list').querySelectorAll('input')[index + offset].focus();
      };
      actions.append(iconButton('↑', '上移目录 ' + (index + 1), () => move(-1), index === 0));
      actions.append(iconButton('↓', '下移目录 ' + (index + 1), () => move(1), index === values.length - 1));
      actions.append(iconButton('×', '移除目录 ' + (index + 1), () => {
        const current = directories();
        current.splice(index, 1);
        dirty = true;
        renderDirectories(current);
      }, values.length === 1));
      row.append(actions);
      list.append(row);
    });
  }

  function updateMode() {
    const creating = !selected && mode === 'new';
    $('mode-existing').classList.toggle('active', !creating);
    $('mode-new').classList.toggle('active', creating);
    $('mode-existing').setAttribute('aria-pressed', String(!creating));
    $('mode-new').setAttribute('aria-pressed', String(creating));
    $('directories-section').hidden = creating;
    $('new-directory-section').hidden = !creating;
    for (const input of $('directory-list').querySelectorAll('input')) input.required = !creating;
    $('save-project').textContent = busy ? '正在保存…' : creating ? '创建项目与目录' : '保存项目';
    updatePreview();
  }

  function updatePreview() {
    $('new-directory-preview').textContent = settings.root + '/' + ($('project-name').value.trim() || '项目名称');
  }

  function openProject(project) {
    selected = project ? project.name : null;
    mode = 'existing';
    dirty = false;
    $('editor-title').textContent = selected || '添加项目';
    $('editor-kicker').textContent = selected ? 'PROJECT SETTINGS' : 'NEW PROJECT';
    $('saved-label').hidden = !selected;
    $('creation-mode').hidden = !!selected;
    $('project-name').value = selected || '';
    $('project-name').disabled = !!selected;
    $('project-agent').value = project ? project.agent : 'codex';
    $('make-default').checked = selected ? settings.default_project === selected : !settings.projects.length;
    $('make-default').disabled = !!selected && settings.default_project === selected;
    $('delete-project').hidden = !selected;
    renderDirectories(project ? project.directories : ['']);
    updateMode();
    renderProjects();
  }

  function setBusy(value) {
    busy = value;
    $('form-fields').disabled = value;
    $('add-project').disabled = value;
    $('confirm-delete').disabled = value;
    $('cancel-delete').disabled = value;
    $('bypass-mode').disabled = value;
    updateMode();
    renderProjects();
  }

  function showBypass() {
    $('bypass-mode').checked = settings.bypass;
    $('bypass-status').textContent = settings.bypass ? '已启用' : '已关闭';
  }

  $('bypass-mode').addEventListener('change', async () => {
    const value = $('bypass-mode').checked;
    setBusy(true);
    $('bypass-status').textContent = '正在保存…';
    try {
      settings = await api('/api/settings', 'PUT', {bypass: value});
      notice(value ? 'Bypass 模式已启用，新启动的会话将跳过 Agent 审批和沙箱限制。' : 'Bypass 模式已关闭，新启动的会话将使用 Agent 的默认审批和沙箱设置。');
    } catch (error) { notice(error.message, true); }
    finally { showBypass(); setBusy(false); }
  });

  $('add-project').addEventListener('click', () => {
    if (!mayLeave()) return;
    $('notice').hidden = true;
    openProject(null);
    $('project-name').focus();
  });
  $('mode-existing').addEventListener('click', () => { mode = 'existing'; updateMode(); });
  $('mode-new').addEventListener('click', () => { mode = 'new'; updateMode(); });
  $('project-name').addEventListener('input', () => { dirty = true; updatePreview(); });
  $('project-agent').addEventListener('change', () => { dirty = true; });
  $('make-default').addEventListener('change', () => { dirty = true; });
  $('add-directory').addEventListener('click', () => {
    renderDirectories([...directories(), '']);
    dirty = true;
    $('directory-list').lastElementChild.querySelector('input').focus();
  });
  $('project-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const name = $('project-name').value.trim();
    if (!selected && settings.projects.some(project => project.name === name)) {
      notice('这个项目名称已经存在，请从左侧选择编辑，或使用其他名称。', true);
      return;
    }
    const creating = !selected && mode === 'new';
    const body = {agent: $('project-agent').value, make_default: $('make-default').checked};
    if (creating) body.name = name;
    else body.directories = directories();
    setBusy(true);
    try {
      settings = await api('/api/projects' + (creating ? '' : '/' + encodeURIComponent(name)), creating ? 'POST' : 'PUT', body);
      showBypass();
      openProject(settings.projects.find(project => project.name === name));
      notice(creating ? '项目已创建。现在可以在飞书里使用“' + name + '”开始开发，也可以继续添加目录。' : '项目已保存。新启动的会话将使用这些目录。');
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  });
  $('delete-project').addEventListener('click', () => $('delete-dialog').showModal());
  $('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
  $('delete-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('confirm-delete').addEventListener('click', async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      settings = await api('/api/projects/' + encodeURIComponent(selected), 'DELETE', {});
      showBypass();
      openProject(settings.projects.find(project => project.name === settings.default_project) || settings.projects[0]);
      $('delete-dialog').close();
      notice('项目配置已移除，本地文件夹和已有任务已保留。');
    } catch (error) { $('delete-dialog').close(); notice(error.message, true); }
    finally { setBusy(false); }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  api('/api/projects').then(result => {
    settings = result;
    $('form-fields').disabled = false;
    $('bypass-mode').disabled = false;
    showBypass();
    openProject(settings.projects.find(project => project.name === settings.default_project) || settings.projects[0]);
  }).catch(error => { notice(error.message, true); $('add-project').disabled = true; });
})();
