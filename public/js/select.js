const SELECT_WRAPPER_SELECTOR = ".select-wrap, .select-field.select-field-compact";
const NATIVE_SELECT_CLASS = "custom-select-native";
const MENU_MARGIN = 8;
const MENU_GAP = 6;
const MENU_MIN_WIDTH = 260;
const MENU_MAX_WIDTH = 480;

const CHEVRON_ICON = `
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

const SEARCH_ICON = `
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="4.25" stroke="currentColor" stroke-width="1.4" />
    <path d="m10.25 10.25 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
`;

const CHECK_ICON = `
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="m3.5 8.25 2.75 2.75 6.25-6.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

const enhancements = new WeakMap();
let activeMenu = null;
let menuSequence = 0;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOptionText(option) {
  return (
    normalizeText(option.textContent) ||
    normalizeText(option.label) ||
    normalizeText(option.value)
  );
}

function parseOptionText(text) {
  const parts = text.split(" — ");

  if (parts.length === 1) {
    return { title: text, detail: "", side: "" };
  }

  if (parts.length === 2) {
    return { title: parts[0], detail: parts[1], side: "" };
  }

  return {
    title: parts[0],
    detail: parts.slice(1, -1).join(" — "),
    side: parts.at(-1),
  };
}

function getSelectedOption(select) {
  if (select.selectedOptions?.length) {
    return select.selectedOptions[0];
  }

  return (
    Array.from(select.options).find((option) => option.selected) ||
    select.options[select.selectedIndex] ||
    null
  );
}

function isOptionDisabled(option) {
  return Boolean(
    option.disabled ||
      (option.parentElement?.tagName === "OPTGROUP" &&
        option.parentElement.disabled),
  );
}

function getDocument(root) {
  if (!root) {
    return null;
  }
  if (root.nodeType === 9) {
    return root;
  }
  return root.ownerDocument || (typeof document === "undefined" ? null : document);
}

function focusElement(element) {
  if (!element?.isConnected) {
    return;
  }

  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function createElement(doc, tagName, className, text) {
  const element = doc.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function syncTrigger(enhancement) {
  const { select, trigger, valueElement, wrapper } = enhancement;

  if (!trigger?.isConnected) {
    return;
  }

  const selectedOption = getSelectedOption(select);
  const label = selectedOption ? getOptionText(selectedOption) : "";
  const triggerLabel = label ? parseOptionText(label).title : "";

  valueElement.textContent = triggerLabel || "请选择";
  valueElement.title = label;
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-disabled", String(select.disabled));
  wrapper.classList.toggle("is-disabled", select.disabled);

  const ariaLabel = select.getAttribute("aria-label");
  if (ariaLabel) {
    trigger.setAttribute("aria-label", ariaLabel);
  } else {
    trigger.removeAttribute("aria-label");
  }
}

function hideLegacyChevron(select, trigger) {
  let sibling = select.nextElementSibling;

  while (sibling) {
    if (sibling !== trigger && sibling.matches?.("svg, .icon")) {
      sibling.hidden = true;
      sibling.dataset.customSelectLegacyIcon = "true";
      sibling.setAttribute("aria-hidden", "true");
      sibling.style.display = "none";
    }
    sibling = sibling.nextElementSibling;
  }
}

function toggleMenu(enhancement) {
  if (activeMenu?.enhancement === enhancement) {
    closeCustomSelect({ restoreFocus: true });
    return;
  }

  openMenu(enhancement);
}

function handleTriggerClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const enhancement = enhancements.get(event.currentTarget.customSelectSelect);
  if (enhancement) {
    toggleMenu(enhancement);
  }
}

function handleTriggerKeydown(event) {
  const enhancement = enhancements.get(event.currentTarget.customSelectSelect);
  if (!enhancement) {
    return;
  }

  if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu(enhancement);
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();

    if (activeMenu?.enhancement !== enhancement) {
      openMenu(enhancement);
    }
  }
}

function handleWrapperClick(event) {
  if (event.target.closest?.(".custom-select-trigger")) {
    return;
  }

  const enhancement = enhancements.get(event.currentTarget.customSelectSelect);
  if (!enhancement) {
    return;
  }

  event.preventDefault();
  toggleMenu(enhancement);
}

function createTrigger(enhancement) {
  const { doc, select, wrapper, menuId } = enhancement;
  const trigger = doc.createElement("button");
  const valueElement = createElement(doc, "span", "custom-select-value");
  const chevron = createElement(doc, "span", "custom-select-chevron");

  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", menuId);
  trigger.dataset.customSelectTrigger = "true";
  trigger.customSelectSelect = select;
  chevron.innerHTML = CHEVRON_ICON;
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(valueElement, chevron);
  select.insertAdjacentElement("afterend", trigger);

  enhancement.trigger = trigger;
  enhancement.valueElement = valueElement;
  enhancement.chevron = chevron;

  trigger.addEventListener("click", handleTriggerClick);
  trigger.addEventListener("keydown", handleTriggerKeydown);
  wrapper.addEventListener("click", handleWrapperClick);
  hideLegacyChevron(select, trigger);

  return trigger;
}

function enhanceSelect(select, wrapper) {
  const doc = select.ownerDocument;
  const win = doc.defaultView;
  const menuId = `custom-select-menu-${++menuSequence}`;
  const originalHeight =
    typeof win?.getComputedStyle === "function"
      ? Number.parseFloat(win.getComputedStyle(select).height)
      : Number.NaN;
  const enhancement = {
    doc,
    select,
    wrapper,
    menuId,
    trigger: null,
    valueElement: null,
    chevron: null,
  };

  enhancements.set(select, enhancement);
  wrapper.classList.add("has-custom-select");
  if (Number.isFinite(originalHeight) && originalHeight > 0) {
    wrapper.style.minHeight = `${Math.ceil(originalHeight)}px`;
  }
  wrapper.customSelectSelect = select;

  select.classList.add(NATIVE_SELECT_CLASS);
  select.dataset.customSelectEnhanced = "true";
  select.setAttribute("aria-hidden", "true");
  if (!select.hasAttribute("data-custom-select-original-tabindex")) {
    select.dataset.customSelectOriginalTabindex =
      select.getAttribute("tabindex") ?? "";
  }
  select.tabIndex = -1;

  const trigger = createTrigger(enhancement);
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-disabled", String(select.disabled));

  select.addEventListener("change", () => {
    const currentEnhancement = enhancements.get(select);
    if (currentEnhancement) {
      syncTrigger(currentEnhancement);
    }
  });

  syncTrigger(enhancement);
  return enhancement;
}

function createSearch(enhancement, menu, optionsContainer, emptyState) {
  const { doc } = enhancement;
  const searchRow = createElement(doc, "div", "custom-select-search");
  const searchIcon = createElement(doc, "span", "custom-select-search-icon");
  const searchInput = doc.createElement("input");

  searchIcon.innerHTML = SEARCH_ICON;
  searchIcon.setAttribute("aria-hidden", "true");
  searchInput.type = "search";
  searchInput.className = "custom-select-search-input";
  searchInput.placeholder = "搜索选项…";
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchInput.setAttribute("aria-label", "搜索选项");

  searchInput.addEventListener("input", () => {
    filterOptions(optionsContainer, emptyState, searchInput.value);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const firstVisibleOption = Array.from(
        optionsContainer.querySelectorAll(
          ".custom-select-option:not(:disabled):not([hidden])",
        ),
      )[0];

      if (firstVisibleOption) {
        event.preventDefault();
        chooseOption(activeMenu, firstVisibleOption);
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const currentActiveMenu = activeMenu;
      if (currentActiveMenu?.menu !== menu) {
        return;
      }

      const options = getNavigableOptions(currentActiveMenu);
      if (!options.length) {
        return;
      }

      event.preventDefault();
      focusOption(
        currentActiveMenu,
        event.key === "ArrowDown" ? options[0] : options.at(-1),
      );
    }
  });

  searchRow.append(searchIcon, searchInput);
  return searchRow;
}

function createOptionButton(enhancement, option, optionIndex, groupDisabled) {
  const { doc, select } = enhancement;
  const fullText = getOptionText(option);
  const { title, detail, side } = parseOptionText(fullText);
  const selected = option.selected && option.index === select.selectedIndex;
  const disabled = groupDisabled || isOptionDisabled(option);
  const button = doc.createElement("button");
  const main = createElement(doc, "span", "custom-select-option-main");
  const titleElement = createElement(
    doc,
    "span",
    "custom-select-option-title",
    title,
  );

  button.type = "button";
  button.className = "custom-select-option";
  button.dataset.optionIndex = String(optionIndex);
  button.dataset.searchText = fullText.toLocaleLowerCase();
  button.dataset.fullText = fullText;
  button.tabIndex = -1;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(selected));
  button.title = fullText;

  if (fullText) {
    button.setAttribute("aria-label", fullText);
  }

  if (selected) {
    button.classList.add("is-selected");
  }
  if (disabled) {
    button.classList.add("is-disabled");
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
  }

  main.append(titleElement);

  if (detail) {
    main.append(
      createElement(doc, "span", "custom-select-option-detail", detail),
    );
  }

  button.append(main);

  button.append(
    createElement(doc, "span", "custom-select-option-side", side),
  );

  const check = createElement(doc, "span", "custom-select-check");
  check.innerHTML = CHECK_ICON;
  check.setAttribute("aria-hidden", "true");
  check.style.visibility = selected ? "visible" : "hidden";
  button.append(check);

  return button;
}

function buildMenu(enhancement) {
  const { doc, select, menuId } = enhancement;
  const menu = doc.createElement("div");
  const optionsContainer = createElement(doc, "div", "custom-select-options");
  const emptyState = createElement(doc, "div", "custom-select-empty");
  const optionIndexes = new Map(
    Array.from(select.options).map((option, index) => [option, index]),
  );
  const allOptions = Array.from(select.options);
  let groupIndex = 0;

  menu.id = menuId;
  menu.className = "custom-select-menu";
  menu.tabIndex = -1;
  menu.setAttribute("role", "listbox");
  menu.setAttribute(
    "aria-label",
    select.getAttribute("aria-label") || "选择选项",
  );

  if (allOptions.length > 7) {
    menu.append(createSearch(enhancement, menu, optionsContainer, emptyState));
  }

  for (const child of Array.from(select.children)) {
    if (child.tagName === "OPTGROUP") {
      const groupOptions = Array.from(child.children).filter(
        (option) => option.tagName === "OPTION",
      );

      if (!groupOptions.length) {
        continue;
      }

      const groupLabelText = normalizeText(child.label) || "选项组";
      const group = createElement(doc, "div", "custom-select-group");
      const labelId = `${menuId}-group-${++groupIndex}`;
      const label = createElement(
        doc,
        "div",
        "custom-select-group-label",
        groupLabelText,
      );

      label.id = labelId;
      group.setAttribute("role", "group");
      group.setAttribute("aria-labelledby", labelId);

      if (child.disabled) {
        group.classList.add("is-disabled");
        group.setAttribute("aria-disabled", "true");
      }

      group.append(label);

      for (const option of groupOptions) {
        group.append(
          createOptionButton(
            enhancement,
            option,
            optionIndexes.get(option),
            child.disabled,
          ),
        );
      }

      optionsContainer.append(group);
      continue;
    }

    if (child.tagName === "OPTION") {
      optionsContainer.append(
        createOptionButton(
          enhancement,
          child,
          optionIndexes.get(child),
          false,
        ),
      );
    }
  }

  emptyState.hidden = optionsContainer.children.length > 0;
  emptyState.style.display = emptyState.hidden ? "none" : "";
  emptyState.setAttribute("role", "status");
  emptyState.textContent = allOptions.length
    ? "未找到匹配选项"
    : "暂无可用选项";
  menu.append(optionsContainer, emptyState);

  return menu;
}

function filterOptions(optionsContainer, emptyState, query) {
  const searchTerm = normalizeText(query).toLocaleLowerCase();
  const optionButtons = Array.from(
    optionsContainer.querySelectorAll(".custom-select-option"),
  );
  let visibleCount = 0;

  for (const optionButton of optionButtons) {
    const matches =
      !searchTerm ||
      (optionButton.dataset.searchText || "").includes(searchTerm);

    optionButton.hidden = !matches;
    optionButton.style.display = matches ? "" : "none";
    if (matches) {
      visibleCount += 1;
    }
  }

  for (const group of optionsContainer.querySelectorAll(
    ".custom-select-group",
  )) {
    const hasVisibleOption = Array.from(
      group.querySelectorAll(".custom-select-option"),
    ).some((optionButton) => !optionButton.hidden);
    const groupLabel = group.querySelector(".custom-select-group-label");

    group.hidden = !hasVisibleOption;
    group.style.display = hasVisibleOption ? "" : "none";

    if (groupLabel) {
      groupLabel.hidden = !hasVisibleOption;
      groupLabel.style.display = hasVisibleOption ? "" : "none";
    }
  }

  emptyState.hidden = visibleCount > 0;
  emptyState.style.display = visibleCount > 0 ? "none" : "";
  if (visibleCount > 0) {
    optionsContainer.scrollTop = 0;
  }
}

function getNavigableOptions(menuState) {
  if (!menuState) {
    return [];
  }

  return Array.from(
    menuState.menu.querySelectorAll(
      ".custom-select-option:not(:disabled):not([hidden])",
    ),
  );
}

function focusOption(menuState, option) {
  if (!menuState || !option) {
    return;
  }

  for (const candidate of menuState.menu.querySelectorAll(
    ".custom-select-option",
  )) {
    candidate.tabIndex = candidate === option ? 0 : -1;
  }

  focusElement(option);
}

function focusInitialOption(menuState) {
  if (!menuState) {
    return;
  }

  const search = menuState.menu.querySelector(".custom-select-search input");
  if (search) {
    focusElement(search);
    return;
  }

  const selectedOption = menuState.menu.querySelector(
    ".custom-select-option.is-selected:not(:disabled):not([hidden])",
  );
  const firstOption = menuState.menu.querySelector(
    ".custom-select-option:not(:disabled):not([hidden])",
  );
  const target = selectedOption || firstOption;

  if (target) {
    focusOption(menuState, target);
  } else {
    focusElement(menuState.menu);
  }
}

function positionMenu(menuState) {
  const { menu, trigger, select, doc } = menuState;
  const win = doc.defaultView || window;
  const viewportWidth =
    win.innerWidth || doc.documentElement?.clientWidth || MENU_MIN_WIDTH;
  const viewportHeight =
    win.innerHeight || doc.documentElement?.clientHeight || 0;
  const triggerRect = trigger.getBoundingClientRect();
  const availableWidth = Math.max(1, viewportWidth - MENU_MARGIN * 2);
  const requestedMinWidth = Number.parseFloat(
    select.dataset.customMenuMinWidth,
  );
  const preferredMinWidth =
    Number.isFinite(requestedMinWidth) && requestedMinWidth > 0
      ? Math.max(MENU_MIN_WIDTH, requestedMinWidth)
      : MENU_MIN_WIDTH;
  const width = Math.min(
    Math.max(triggerRect.width, preferredMinWidth),
    MENU_MAX_WIDTH,
    availableWidth,
  );
  const minWidth = Math.min(preferredMinWidth, availableWidth);
  const maxWidth = Math.min(MENU_MAX_WIDTH, availableWidth);
  const left = Math.max(
    MENU_MARGIN,
    Math.min(triggerRect.left, viewportWidth - MENU_MARGIN - width),
  );
  const spaceBelow = Math.max(
    0,
    viewportHeight - triggerRect.bottom - MENU_GAP - MENU_MARGIN,
  );
  const spaceAbove = Math.max(0, triggerRect.top - MENU_GAP - MENU_MARGIN);

  menu.style.position = "fixed";
  menu.style.boxSizing = "border-box";
  menu.style.left = `${left}px`;
  menu.style.top = "0px";
  menu.style.bottom = "auto";
  menu.style.width = `${width}px`;
  menu.style.minWidth = `${minWidth}px`;
  menu.style.maxWidth = `${maxWidth}px`;
  menu.style.visibility = "hidden";
  menu.style.pointerEvents = "none";

  const naturalHeight = menu.getBoundingClientRect().height;
  const minimumOpenHeight = Math.min(320, viewportHeight * 0.4);
  const openAbove =
    spaceBelow < minimumOpenHeight && spaceAbove > spaceBelow;
  const availableHeight = openAbove ? spaceAbove : spaceBelow;
  const computedMaxHeight =
    typeof win.getComputedStyle === "function"
      ? Number.parseFloat(win.getComputedStyle(menu).maxHeight)
      : Number.NaN;
  const cssMaxHeight = Number.isFinite(computedMaxHeight)
    ? computedMaxHeight
    : Number.POSITIVE_INFINITY;

  menu.classList.toggle("is-above", openAbove);
  menu.style.maxHeight = `${Math.floor(
    Math.min(availableHeight, cssMaxHeight),
  )}px`;

  if (openAbove) {
    menu.style.top = "auto";
    menu.style.bottom = `${viewportHeight - triggerRect.top + MENU_GAP}px`;
  } else {
    menu.style.top = `${triggerRect.bottom + MENU_GAP}px`;
    menu.style.bottom = "auto";
  }

  menu.style.visibility = "";
  menu.style.pointerEvents = "";
}

function openMenu(enhancement) {
  if (
    !enhancement ||
    !enhancement.select.isConnected ||
    enhancement.select.disabled ||
    !enhancement.trigger.isConnected
  ) {
    return;
  }

  closeCustomSelect();

  const { doc, trigger, wrapper, select } = enhancement;
  const menu = buildMenu(enhancement);
  const win = doc.defaultView || window;
  const menuState = {
    enhancement,
    doc,
    win,
    menu,
    openedAt: Date.now(),
    trigger,
    wrapper,
    select,
    handleOutsidePointerDown,
    handleDocumentKeydown,
    handleMenuKeydown,
    handleMenuClick,
    handleWindowResize,
    handleCapturedScroll,
  };

  doc.body.append(menu);
  activeMenu = menuState;

  wrapper.classList.add("is-open");
  menu.classList.add("is-open");
  trigger.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");

  menu.addEventListener("keydown", handleMenuKeydown);
  menu.addEventListener("click", handleMenuClick);
  doc.addEventListener("pointerdown", handleOutsidePointerDown, true);
  doc.addEventListener("keydown", handleDocumentKeydown, true);
  win.addEventListener("resize", handleWindowResize);
  win.addEventListener("scroll", handleCapturedScroll, true);

  positionMenu(menuState);
  focusInitialOption(menuState);
}

function handleOutsidePointerDown(event) {
  if (!activeMenu) {
    return;
  }

  const { menu, trigger, wrapper } = activeMenu;
  const target = event.target;

  if (
    menu.contains(target) ||
    trigger.contains(target) ||
    wrapper.contains(target)
  ) {
    return;
  }

  closeCustomSelect();
}

function handleDocumentKeydown(event) {
  if (!activeMenu) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCustomSelect({ restoreFocus: true });
    return;
  }

  if (event.key === "Tab") {
    closeCustomSelect({ restoreFocus: true });
  }
}

function handleMenuKeydown(event) {
  const menuState = activeMenu;
  if (!menuState) {
    return;
  }

  const target = event.target;
  const isOptionTarget =
    target?.nodeType === 1 && target.classList.contains("custom-select-option");

  if (
    isOptionTarget &&
    (event.key === "Enter" || event.key === " " || event.key === "Spacebar")
  ) {
    event.preventDefault();
    event.stopPropagation();
    chooseOption(menuState, target);
    return;
  }

  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }

  const navigableOptions = getNavigableOptions(menuState);
  if (!navigableOptions.length) {
    return;
  }

  event.preventDefault();
  const currentIndex = navigableOptions.indexOf(document.activeElement);
  let nextIndex = 0;

  if (event.key === "ArrowDown") {
    nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + 1) % navigableOptions.length;
  } else if (event.key === "ArrowUp") {
    nextIndex =
      currentIndex < 0
        ? navigableOptions.length - 1
        : (currentIndex - 1 + navigableOptions.length) %
          navigableOptions.length;
  } else if (event.key === "End") {
    nextIndex = navigableOptions.length - 1;
  }

  focusOption(menuState, navigableOptions[nextIndex]);
}

function handleMenuClick(event) {
  const target = event.target;
  if (target?.nodeType !== 1) {
    return;
  }

  const optionButton = target.closest(".custom-select-option");
  if (
    !optionButton ||
    !activeMenu?.menu.contains(optionButton) ||
    optionButton.disabled
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  chooseOption(activeMenu, optionButton);
}

function handleWindowResize() {
  closeCustomSelect();
}

function handleCapturedScroll(event) {
  if (!activeMenu) {
    return;
  }

  if (Date.now() - activeMenu.openedAt < 180) {
    return;
  }

  const target = event.target;
  const targetIsNode =
    target && typeof target === "object" && "nodeType" in target;

  if (targetIsNode && activeMenu.menu.contains(target)) {
    return;
  }

  closeCustomSelect();
}

function chooseOption(menuState, optionButton) {
  if (!menuState) {
    return;
  }

  const { enhancement, select } = menuState;
  const optionIndex = Number(optionButton.dataset.optionIndex);
  const option = select.options[optionIndex];

  if (!option || isOptionDisabled(option)) {
    return;
  }

  select.value = option.value;
  if (select.selectedIndex !== optionIndex) {
    select.selectedIndex = optionIndex;
  }

  syncTrigger(enhancement);
  closeCustomSelect({ restoreFocus: true });

  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function closeCustomSelect(options = {}) {
  if (!activeMenu) {
    return;
  }

  const menuState = activeMenu;
  const restoreFocus =
    typeof options === "boolean" ? options : Boolean(options?.restoreFocus);

  activeMenu = null;
  menuState.menu.removeEventListener("keydown", menuState.handleMenuKeydown);
  menuState.menu.removeEventListener("click", menuState.handleMenuClick);
  menuState.doc.removeEventListener(
    "pointerdown",
    menuState.handleOutsidePointerDown,
    true,
  );
  menuState.doc.removeEventListener(
    "keydown",
    menuState.handleDocumentKeydown,
    true,
  );
  menuState.win.removeEventListener("resize", menuState.handleWindowResize);
  menuState.win.removeEventListener(
    "scroll",
    menuState.handleCapturedScroll,
    true,
  );

  menuState.menu.remove();
  menuState.wrapper.classList.remove("is-open");
  menuState.trigger.classList.remove("is-open");
  menuState.trigger.setAttribute("aria-expanded", "false");

  if (restoreFocus) {
    focusElement(menuState.trigger);
  }
}

export function enhanceSelects(root = document) {
  closeCustomSelect();

  const doc = getDocument(root);
  if (!doc?.body) {
    return;
  }

  const selects = new Set();

  if (root.nodeType === 1 && root.matches?.("select")) {
    selects.add(root);
  }

  if (root.querySelectorAll) {
    for (const select of root.querySelectorAll("select")) {
      selects.add(select);
    }
  }

  for (const select of selects) {
    const wrapper = select.closest?.(SELECT_WRAPPER_SELECTOR);
    if (!wrapper) {
      continue;
    }

    const existing = enhancements.get(select);
    if (
      existing?.trigger?.isConnected &&
      existing.wrapper === wrapper &&
      select.classList.contains(NATIVE_SELECT_CLASS)
    ) {
      syncTrigger(existing);
      continue;
    }

    enhanceSelect(select, wrapper);
  }
}
