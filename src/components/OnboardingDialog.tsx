import { memo, useEffect, useRef } from 'react';
import { BrandMark, Icon, MotionIcon, type IconName } from './Icons';
import './OnboardingDialog.css';

export const ONBOARDING_STEPS: Array<{ icon: IconName; eyebrow: string; title: string; description: string; points: string[] }> = [
  {
    icon: 'guide',
    eyebrow: 'Visão geral',
    title: 'Bem-vindo ao ScreenLink',
    description: 'Salas diretas para voz, chat e compartilhamento de tela. Sem cadastro.',
    points: ['Perfil salvo apenas neste dispositivo', 'Conexão direta entre participantes']
  },
  {
    icon: 'users',
    eyebrow: 'Sala',
    title: 'Inicie ou entre com código',
    description: 'Crie uma sala pelo botão principal ou cole um código no painel de controles.',
    points: ['Código curto e link prontos na hora', 'Chat recolhível a qualquer momento']
  },
  {
    icon: 'microphone',
    eyebrow: 'Controles',
    title: 'Áudio e tela independentes',
    description: 'Ative o microfone ou compartilhe a tela quando precisar. Use as setas para dispositivos e qualidade.',
    points: ['Parar a tela mantém a chamada ativa', 'Mais opções reúne tela cheia e miniplayer']
  },
  {
    icon: 'grid',
    eyebrow: 'Transmissões',
    title: 'Foque a tela principal',
    description: 'Com várias telas ativas, destaque uma delas enquanto as outras ficam acessíveis ao lado.',
    points: ['Troque de tela com um clique', 'Ver todas retorna à grade completa']
  }
];

const OnboardingPreview = memo(function OnboardingPreview({ step }: { step: number }) {
  return (
    <div className={`onboarding-preview is-step-${step}`} aria-hidden="true">
      <div className="onboarding-preview-app">
        <aside className="preview-sidebar preview-sidebar-left">
          <div className="preview-brand"><BrandMark /><i /></div>
          {step === 3
            ? <div className="preview-chat-thread"><span /><span /><span /></div>
            : <div className="preview-sidebar-lines"><i /><i /><i /></div>}
          <div className="preview-profile"><span /><i /></div>
        </aside>
        <section className="preview-stage">
          {step === 0 && (
            <div className="preview-welcome">
              <div className="preview-brand-tile"><BrandMark /></div>
              <strong>Sua sala pronta</strong>
              <span>Voz · tela · chat</span>
            </div>
          )}
          {step === 1 && (
            <div className="preview-room-entry">
              <div className="preview-brand-tile"><BrandMark /></div>
              <strong>Inicie uma chamada</strong>
              <span className="preview-start-button"><Icon name="users" />Iniciar chamada</span>
            </div>
          )}
          {step === 2 && (
            <>
              <div className="preview-call-person"><span /><strong>Você</strong></div>
              <div className="preview-audio-card"><i /><i /><i /></div>
              <div className="preview-dock">
                <span><Icon name="volume" /></span>
                <span className="is-highlighted"><Icon name="microphone" /></span>
                <span className="is-highlighted"><Icon name="screen" /></span>
                <span><Icon name="chat" /></span>
                <span><Icon name="more" /></span>
              </div>
            </>
          )}
          {step === 3 && (
            <div className="preview-screen-focus">
              <div className="preview-main-screen">
                <span />
                <strong>Tela de Ana</strong>
                <i><Icon name="expand" /></i>
              </div>
              <div className="preview-screen-list">
                <span className="preview-all-screens"><Icon name="grid" />Todas</span>
                <div><span /><strong>Tela de Bruno</strong></div>
                <div><span /><strong>Sua tela</strong></div>
              </div>
            </div>
          )}
        </section>
        <aside className="preview-sidebar preview-sidebar-right">
          <strong>Controles</strong>
          {step === 1 ? (
            <>
              <label>Entrar com código</label>
              <div className="preview-code"><Icon name="link" /><span>AB12CD</span></div>
              <span className="preview-enter-button">Entrar</span>
            </>
          ) : (
            <div className="preview-settings-lines"><i /><i /><i /><i /></div>
          )}
        </aside>
      </div>
    </div>
  );
});

export interface OnboardingDialogProps {
  open: boolean;
  className: string;
  step: number;
  onStepChange: (next: number | ((current: number) => number)) => void;
  onFinish: () => void;
}

const OnboardingDialog = memo(function OnboardingDialog({
  open,
  className,
  step,
  onStepChange,
  onFinish
}: OnboardingDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onboarding = ONBOARDING_STEPS[step] ?? ONBOARDING_STEPS[0];

  useEffect(() => {
    if (!open) return;
    const handleTutorialKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onFinish();
        return;
      }
      if (event.key === 'ArrowRight') onStepChange(current => Math.min(ONBOARDING_STEPS.length - 1, current + 1));
      if (event.key === 'ArrowLeft') onStepChange(current => Math.max(0, current - 1));
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    document.addEventListener('keydown', handleTutorialKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleTutorialKeys);
    };
  }, [onFinish, onStepChange, open]);

  return (
    <div className={`onboarding-backdrop motion-overlay ${className}`} role="presentation">
      <section
        ref={dialogRef}
        className={`onboarding-dialog t-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-description"
        tabIndex={-1}
      >
        <header>
          <div className="onboarding-brand"><BrandMark /><span>Guia rápido</span></div>
          <span className="onboarding-counter">{String(step + 1).padStart(2, '0')} / {String(ONBOARDING_STEPS.length).padStart(2, '0')}</span>
          <button type="button" onClick={onFinish} aria-label="Fechar tutorial"><Icon name="close" /></button>
        </header>
        <OnboardingPreview step={step} />
        <div className="onboarding-content t-stagger is-shown" key={`copy-${step}`}>
          <div className="onboarding-step-label t-stagger-line t-stagger-line--1"><Icon name={onboarding.icon} /><span>{onboarding.eyebrow}</span></div>
          <h2 className="t-stagger-line t-stagger-line--2" id="onboarding-title">{onboarding.title}</h2>
          <p className="t-stagger-line t-stagger-line--3" id="onboarding-description">{onboarding.description}</p>
          <div className="onboarding-notes t-stagger-line t-stagger-line--4">{onboarding.points.map(point => <span key={point}><Icon name="check" />{point}</span>)}</div>
        </div>
        <nav className="onboarding-progress" aria-label="Progresso do tutorial">
          {ONBOARDING_STEPS.map((item, index) => (
            <button
              key={item.title}
              className={index === step ? 'is-current' : index < step ? 'is-complete' : ''}
              type="button"
              onClick={() => onStepChange(index)}
              aria-label={`Ir para etapa ${index + 1}`}
              aria-current={index === step ? 'step' : undefined}
            >
              <span>{index + 1}</span>
            </button>
          ))}
        </nav>
        <footer>
          <button className="onboarding-skip" type="button" onClick={onFinish}>Pular</button>
          <div>
            <button type="button" onClick={() => onStepChange(current => Math.max(0, current - 1))} disabled={step === 0}>Anterior</button>
            <button
              className="is-primary"
              type="button"
              onClick={() => step === ONBOARDING_STEPS.length - 1 ? onFinish() : onStepChange(current => current + 1)}
            >
              {step === ONBOARDING_STEPS.length - 1 ? 'Abrir ScreenLink' : 'Próximo'}
              <MotionIcon active={step === ONBOARDING_STEPS.length - 1} activeIcon="check" inactiveIcon="chevron" />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
});

export default OnboardingDialog;
