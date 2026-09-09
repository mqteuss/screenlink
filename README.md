# ScreenLink

Compartilhamento de tela simples entre um computador e um celular ou outro computador. O transmissor e o espectador usam o mesmo endereço; não é necessário instalar um aplicativo.

## Experiência do MVP

1. Abra o ScreenLink no Chrome ou Edge do computador.
2. Clique em **Compartilhar minha tela** e escolha uma tela ou janela.
3. Copie o link privado exibido.
4. Abra o link em outro celular ou computador, inclusive em outra rede Wi-Fi ou no 4G/5G.
5. Clique em **Encerrar compartilhamento** quando terminar.

Cada sala aceita um único espectador. O compartilhamento é 1080p a até 30 fps e não inclui áudio nesta primeira versão.

## Arquitetura

Existe apenas um serviço Node.js:

- entrega a interface web;
- mantém a sala privada temporária;
- encaminha somente as mensagens necessárias para formar a conexão WebRTC.

O vídeo viaja diretamente entre os dispositivos por WebRTC P2P. O STUN ajuda os
navegadores a descobrir esse caminho, e o próprio WebRTC adapta bitrate, resolução
e quadros conforme a rede. Não há servidor TURN nem retransmissão de vídeo. O
ScreenLink não grava o conteúdo.

## Executar localmente

Requisitos: Node.js 22 ou mais recente.

```powershell
npm install
npm run build
npm start
```

Abra `http://localhost:8787` no computador que vai compartilhar. O convite gerado
usa automaticamente o IPv4 da rede local quando a página do transmissor está em
`localhost`. O computador continua usando `localhost`, porque a captura de tela
do navegador exige um contexto seguro.

Para testar no celular, abra primeiro `http://IP-DO-PC:8787/health`. Se não abrir:

1. confirme que os dois dispositivos estão na mesma rede;
2. marque essa rede do Windows como **Privada**;
3. permita a porta TCP 8787 no Firewall do Windows somente para redes privadas.

É possível forçar a origem colocada nos convites com `PUBLIC_ORIGIN`, por exemplo
ao usar um domínio público ou túnel HTTPS.

## Uso em redes diferentes

O endereço público HTTPS do Render permite que os dois dispositivos entrem na
mesma sala. A conexão de vídeo ainda depende de o WebRTC encontrar um caminho P2P
direto com ajuda do STUN. Isso funciona em muitas redes domésticas e móveis, mas
não é garantido: NAT simétrico, CGNAT ou firewalls restritivos podem impedir a
transmissão. Essa é a limitação deliberada do modo sem TURN.

## Publicar no Render

O arquivo `render.yaml` descreve o deploy completo em um único Web Service.

1. Coloque o conteúdo desta pasta em um repositório Git.
2. No Render, crie um **Blueprint** a partir do repositório.
3. Aguarde o build e abra o endereço `onrender.com` fornecido.
4. Confira `/health`. O campo `mode` deve ser `p2p-stun`.

O plano gratuito do Render pode adormecer após um período sem uso. O primeiro acesso seguinte pode levar alguns segundos para despertar o serviço; isso não muda a arquitetura.

## Segurança e privacidade

- O identificador e a chave da sala são gerados aleatoriamente no navegador.
- A chave fica no fragmento `#` do link, que não é enviado durante a requisição HTTP da página.
- O servidor mantém somente o hash SHA-256 da chave enquanto a transmissão está ativa.
- A sala é apagada da memória quando o transmissor encerra ou perde a conexão.
- Um segundo espectador é recusado.
- Cabeçalhos de segurança bloqueiam câmera, microfone, incorporação em outros sites e carregamento de scripts externos.

## Comandos

```powershell
npm run dev    # interface local com atualização automática
npm run build  # checagem TypeScript e build de produção
npm test       # teste do site e do protocolo de sinalização
npm start      # servidor único de produção
```
