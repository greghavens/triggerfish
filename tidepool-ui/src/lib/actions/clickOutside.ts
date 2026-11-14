/**
 * Svelte action: invoke a callback when clicking outside the element.
 */

export function clickOutside(
  node: HTMLElement,
  onOutside: () => void,
): { update(callback: () => void): void; destroy(): void } {
  function handleClick(event: MouseEvent): void {
    if (!node.contains(event.target as Node)) {
      onOutside();
    }
  }

  document.addEventListener("click", handleClick, true);

  return {
    update(callback) {
      onOutside = callback;
    },
    destroy() {
      document.removeEventListener("click", handleClick, true);
    },
  };
}
