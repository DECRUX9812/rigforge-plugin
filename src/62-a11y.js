// ── a11y: a dialog should behave like one ───────────────────────────────────
// Three things people expect from a modal and none of them are free: Escape
// closes it, Tab stays inside it, and closing puts focus back where you were.
// Without the third, a keyboard user gets dumped at the top of the document and
// has to tab back to wherever they were — which, in a studio with a viewport,
// means past every control on the page.

function useDialogFocus(open, onClose) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const el = ref.current
    const previous = document.activeElement

    const focusables = () => {
      if (!el) return []
      return Array.from(el.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && n.getClientRects().length > 0)
    }

    const t = setTimeout(() => {
      const list = focusables()
      const target = list.find((n) => n.getAttribute('autofocus') !== null) || list[0] || el
      if (target && target.focus) target.focus()
    }, 20)

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const i = list.indexOf(document.activeElement)
      const next = e.shiftKey
        ? (i <= 0 ? list.length - 1 : i - 1)
        : (i === -1 || i === list.length - 1 ? 0 : i + 1)
      e.preventDefault()
      list[next].focus()
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      if (previous && previous.focus && document.contains(previous)) previous.focus()
    }
  }, [open])

  return ref
}
