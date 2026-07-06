import styles from './ImageViewer.module.css'

interface ImageViewerProps {
  dataUrl: string
  fileName: string
}

/** Read-only image preview on a checkerboard background so transparency is visible. */
export function ImageViewer({ dataUrl, fileName }: ImageViewerProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <img className={styles.image} src={dataUrl} alt={fileName} />
    </div>
  )
}
