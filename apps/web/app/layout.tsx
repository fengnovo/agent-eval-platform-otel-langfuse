import './globals.css';
// 根布局只提供全局样式和内容宽度容器，页面具体内容由各 route 负责。
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body>
        <div className='wrap'>{children}</div>
      </body>
    </html>
  );
}
