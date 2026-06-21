export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else if (name === 'checked') element.checked = Boolean(value);
    else if (name === 'disabled') element.disabled = Boolean(value);
    else if (name === 'selected') element.selected = Boolean(value);
    else if (name === 'value') element.value = value;
    else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'dataset') Object.assign(element.dataset, value);
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(element, ...children) {
  element.replaceChildren();
  append(element, children);
}

export function formatPercent(count, total) {
  if (!total) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

export function copyText(text) {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('Clipboard unavailable'));
}
