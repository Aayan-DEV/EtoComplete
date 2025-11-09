// Full-screen sections with reveal-on-scroll animations + subtle parallax for “1000x”
document.addEventListener('DOMContentLoaded', () => {
  // Reveal cards/sections when they enter viewport
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add('is-visible');
    });
  }, { threshold: 0.2 });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  // Subtle parallax for the hero “1000x” word
  const heroAccent = document.querySelector('[data-parallax="hero-1000x"]');
  const onScroll = () => {
    if (!heroAccent) return;
    const viewportH = window.innerHeight || 1;
    const scrolled = Math.min(window.scrollY / viewportH, 1);
    const translate = Math.round(scrolled * 18); // up to ~18px
    heroAccent.style.transform = `translateY(${translate}px)`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
});