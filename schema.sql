-- Maths Exhibition Feedback System
-- Run this entire file once in Supabase Dashboard > SQL Editor.

create table if not exists public.stalls (
  id bigserial primary key,
  stall_number integer not null unique,
  name text not null default '',
  tagline text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id bigserial primary key,
  stall_id bigint not null references public.stalls(id) on delete cascade,
  question_text text not null,
  question_type text not null check (question_type in ('choice', 'text', 'rating')),
  options jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  is_overall boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint overall_question_must_be_choice check (not is_overall or question_type = 'choice')
);

create unique index if not exists one_overall_question_per_stall
  on public.questions(stall_id) where is_overall = true;

create table if not exists public.reviews (
  id bigserial primary key,
  stall_id bigint not null references public.stalls(id) on delete cascade,
  device_hash char(64) not null,
  overall_rating smallint not null check (overall_rating between 1 and 4),
  answers jsonb not null default '{}'::jsonb,
  review_text text not null default '',
  created_at timestamptz not null default now(),
  constraint one_review_per_device_per_stall unique (stall_id, device_hash)
);

create index if not exists reviews_stall_created_idx on public.reviews(stall_id, created_at desc);
create index if not exists reviews_created_idx on public.reviews(created_at desc);

-- Add 50 starter stalls. The organiser can create more from the dashboard.
insert into public.stalls (stall_number, name, tagline)
select n, 'Stall ' || n, 'Maths Exhibition Project ' || n
from generate_series(1, 50) as n
on conflict (stall_number) do nothing;

-- Every stall starts with the same overall rating question. It can be edited,
-- but not deleted, from the organiser dashboard.
insert into public.questions
  (stall_id, question_text, question_type, options, required, is_overall, sort_order)
select s.id,
       'How would you rate this stall?',
       'choice',
       '["Excellent", "Good", "Average", "Needs Improvement"]'::jsonb,
       true,
       true,
       1
from public.stalls s
where not exists (
  select 1 from public.questions q where q.stall_id = s.id and q.is_overall = true
);
