document.addEventListener('DOMContentLoaded', () => {
  const title = document.querySelector('.coming-soon');
  if (!title) return;
  title.style.opacity = '0';
  title.style.transform = 'translateY(8px)';
  requestAnimationFrame(() => {
    title.style.transition = 'opacity 400ms ease, transform 400ms ease';
    title.style.opacity = '0.9';
    title.style.transform = 'translateY(0)';
  });
});