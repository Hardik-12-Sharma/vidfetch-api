'use client';
import { useState, type FormEvent } from 'react';
import { WEB3FORMS_KEY } from '@/lib/env';

type State = 'idle' | 'sending' | 'done' | 'error';

const RATING_LABELS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

/** Gold gradient used by every lit star. Rendered once; the stars reference it as url(#vf-star-gold). */
function StarDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="vf-star-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9a0" />
          <stop offset="0.55" stopColor="#ffb830" />
          <stop offset="1" stopColor="#f08a00" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function StarShape() {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      <path className="sp" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}

export function Reviews() {
  const [name, setName] = useState('');
  const [rating, setRating] = useState(5);
  const [touched, setTouched] = useState(false);   // the pop animation only plays after a click, never on page load
  const [hover, setHover] = useState(0);   // star under the mouse / keyboard focus: previews the rating before it is chosen
  const [review, setReview] = useState('');
  const [state, setState] = useState<State>('idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!review.trim()) return;
    if (!WEB3FORMS_KEY) { setState('error'); return; }
    setState('sending');
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_KEY, subject: 'New review on Fastest Insta Video Downloader',
          name: name.trim() || 'Anonymous', rating: `${rating}/5`, message: review.trim(), botcheck: '',
        }),
      });
      const data = (await res.json()) as { success?: boolean };
      if (!data.success) throw new Error('failed');
      setState('done'); setName(''); setReview(''); setRating(5);
    } catch { setState('error'); }
  };

  const shown = hover || rating;

  return (
    <section className="card rev" id="reviews">
      <h2>User <span className="pink">Reviews</span></h2>
      <div className="revgrid">
        <div className="rlist"><p className="empty">No reviews yet. Be the first to write one.</p></div>
        <form className="rf" onSubmit={submit}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" aria-label="Your name" maxLength={40} />
          <div className="star-row">
            <StarDefs />
            <div className="star-in" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button type="button" key={n} role="radio" aria-checked={n === rating} aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  className={`${n <= shown ? 'on' : ''}${touched && n === rating ? ' cur' : ''}`}
                  onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)} onClick={() => { setRating(n); setTouched(true); }}>
                  <StarShape />
                </button>
              ))}
            </div>
            <span className="star-label" aria-live="polite"><b>{shown}/5</b> {RATING_LABELS[shown]}</span>
          </div>
          <textarea value={review} onChange={(e) => setReview(e.target.value)} placeholder="Write your review..." aria-label="Your review" maxLength={500} required />
          <button className="send" disabled={state === 'sending'}>{state === 'sending' ? 'Sending...' : 'Submit review'}</button>
          <p className="msg" role="status" style={{ color: state === 'error' ? '#d6204f' : '#0f9d74' }}>
            {state === 'done' && 'Thanks! Your review was sent.'}
            {state === 'error' && (WEB3FORMS_KEY ? 'Could not send. Please try again.' : 'Reviews are not set up yet (NEXT_PUBLIC_WEB3FORMS_KEY is empty).')}
          </p>
        </form>
      </div>
    </section>
  );
}
