export function icon(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.getAttribute("data-icon");
    element.innerHTML = icon(name, "icon");
  });
}
