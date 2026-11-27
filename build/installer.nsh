!macro customHeader
  !ifndef MUI_HEADERIMAGE_BITMAP_STRETCH
    !define MUI_HEADERIMAGE_BITMAP_STRETCH NoStretch
  !endif
  !ifndef MUI_FINISHPAGE_TITLE
    !define MUI_FINISHPAGE_TITLE "ScreenLink instalado"
  !endif
  !ifndef MUI_FINISHPAGE_TEXT
    !define MUI_FINISHPAGE_TEXT "Tudo pronto. Você já pode iniciar suas chamadas com o ScreenLink."
  !endif
  !ifndef MUI_FINISHPAGE_RUN_TEXT
    !define MUI_FINISHPAGE_RUN_TEXT "Abrir ScreenLink agora"
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao ScreenLink"
  !define MUI_WELCOMEPAGE_TEXT "Instale o ScreenLink no seu computador para chamadas diretas de voz, chat e compartilhamento de tela.$\r$\n$\r$\nClique em Avançar para continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend
