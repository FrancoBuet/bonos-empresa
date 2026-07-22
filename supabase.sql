create extension if not exists pgcrypto;

create table if not exists public.bono_config (
  id integer primary key default 1,
  empresa text not null default 'Empresa bonos verduleria',
  monto_mensual numeric(14, 2) not null default 10000,
  updated_at timestamptz not null default now(),
  constraint bono_config_singleton check (id = 1)
);

create table if not exists public.bono_empleados (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  dni text not null unique,
  legajo text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bono_usos (
  id uuid primary key default gen_random_uuid(),
  empleado_id uuid not null references public.bono_empleados(id) on delete cascade,
  periodo char(7) not null check (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  monto numeric(14, 2) not null,
  usado_at timestamptz not null default now(),
  unique (empleado_id, periodo)
);

insert into public.bono_config (id, empresa, monto_mensual)
values (1, 'Empresa bonos verduleria', 10000)
on conflict (id) do nothing;

alter table public.bono_config enable row level security;
alter table public.bono_empleados enable row level security;
alter table public.bono_usos enable row level security;
