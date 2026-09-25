import { Component, type ErrorInfo, type ReactNode } from 'react'

interface SafeSectionState {
  failed: boolean
}

/**
 * Renders nothing, rather than taking the app down, when what it wraps throws.
 *
 * For extras only: the post-Drink summary and the figures derived from
 * history. React unmounts the whole root on an uncaught render error, and the
 * update prompt is a sibling of <App/> under that same root — so without this
 * a bug in an insight would blank the screen *and* remove the one control that
 * could deliver the fix. The Drink itself is already recorded by then, and
 * the card's Put Back does not depend on anything in here.
 */
export class SafeSection extends Component<{ children: ReactNode }, SafeSectionState> {
  state: SafeSectionState = { failed: false }
  private reported = false

  static getDerivedStateFromError(): SafeSectionState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Once: a section that keeps failing would otherwise fill the console.
    if (this.reported) return
    this.reported = true
    console.error('A section failed to render and was hidden.', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
