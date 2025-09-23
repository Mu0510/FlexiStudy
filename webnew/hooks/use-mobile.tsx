import * as React from "react"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(false)

  React.useEffect(() => {
    const isMobileDevice = /Mobi/i.test(window.navigator.userAgent)
    setIsMobile(isMobileDevice)
  }, [])

  return isMobile
}
