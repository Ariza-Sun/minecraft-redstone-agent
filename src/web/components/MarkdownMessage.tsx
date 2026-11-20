import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
}

export function MarkdownMessage({ content }: Props) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}
