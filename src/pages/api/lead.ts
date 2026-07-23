import type { APIRoute } from 'astro';

export const prerender = false;

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = 'noreply@futurite.info';
const RECIPIENT_EMAILS = ['ventas@grupoenergeticos.com'];
const N8N_WEBHOOK_URL = import.meta.env.N8N_WEBHOOK_URL;

const ENERGY_TYPES = new Set([
	'Diesel Industrial',
	'Combustoleo Ligero/Pesado',
	'Combustoleo Alterno ED-40',
	'Gas Natural',
]);

const VOLUME_OPTIONS = new Set(['Si', 'No']);

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid'] as const;
const UTM_LABELS: Record<(typeof UTM_KEYS)[number], string> = {
	utm_source: 'UTM Source',
	utm_medium: 'UTM Medium',
	utm_campaign: 'UTM Campaign',
	utm_term: 'UTM Term',
	utm_content: 'UTM Content',
	gclid: 'Google Click ID',
};
const UTM_VALUE_REGEX = /^[A-Za-z0-9._\-|%{}()+ ]{1,200}$/;

const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ\s.'-]{3,100}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9()+\-\s]{10,20}$/;
const CITY_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s.,'-]{2,100}$/;
const COMPANY_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s.,&'-]{2,150}$/;

const MIN_FILL_TIME_MS = 3000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const timestamps = (requestLog.get(ip) ?? []).filter(
		(t) => now - t < RATE_LIMIT_WINDOW_MS
	);

	if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
		requestLog.set(ip, timestamps);
		return true;
	}

	timestamps.push(now);
	requestLog.set(ip, timestamps);
	return false;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

interface FieldRule {
	regex: RegExp;
	label: string;
}

const FIELD_RULES: Record<string, FieldRule> = {
	fullName: { regex: NAME_REGEX, label: 'Nombre Completo' },
	corporateEmail: { regex: EMAIL_REGEX, label: 'Correo Corporativo' },
	businessPhone: { regex: PHONE_REGEX, label: 'Teléfono Empresarial' },
	companyName: { regex: COMPANY_REGEX, label: 'Nombre de la Empresa' },
	operationCity: { regex: CITY_REGEX, label: 'Ciudad de la Operación' },
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
	let body: Record<string, unknown>;

	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Solicitud inválida.' }), {
			status: 400,
		});
	}

	// Honeypot: bots tend to fill every visible-looking field, including this hidden one.
	if (typeof body.website === 'string' && body.website.trim() !== '') {
		return new Response(JSON.stringify({ success: true }), { status: 200 });
	}

	// Time-trap: legitimate users take at least a few seconds to fill the form.
	const formLoadedAt = Number(body.formLoadedAt);
	if (!formLoadedAt || Date.now() - formLoadedAt < MIN_FILL_TIME_MS) {
		return new Response(JSON.stringify({ error: 'Solicitud inválida.' }), {
			status: 400,
		});
	}

	const ip = clientAddress || request.headers.get('x-forwarded-for') || 'unknown';
	if (isRateLimited(ip)) {
		return new Response(
			JSON.stringify({ error: 'Demasiadas solicitudes. Intenta más tarde.' }),
			{ status: 429 }
		);
	}

	const errors: Record<string, string> = {};
	const clean: Record<string, string> = {};

	for (const [field, rule] of Object.entries(FIELD_RULES)) {
		const raw = body[field];
		const value = typeof raw === 'string' ? raw.trim() : '';

		if (!value) {
			errors[field] = `${rule.label} es obligatorio.`;
		} else if (!rule.regex.test(value)) {
			errors[field] = `${rule.label} no tiene un formato válido.`;
		} else {
			clean[field] = value;
		}
	}

	const energyType = typeof body.energyType === 'string' ? body.energyType.trim() : '';
	if (!energyType) {
		errors.energyType = 'Selecciona un tipo de energético.';
	} else if (!ENERGY_TYPES.has(energyType)) {
		errors.energyType = 'Selecciona una opción válida.';
	} else {
		clean.energyType = energyType;
	}

	const minVolume = typeof body.minVolume === 'string' ? body.minVolume.trim() : '';
	if (!minVolume) {
		errors.minVolume = 'Indica si tu consumo por pedido es igual o mayor a 5,000 litros.';
	} else if (!VOLUME_OPTIONS.has(minVolume)) {
		errors.minVolume = 'Selecciona una opción válida.';
	} else {
		clean.minVolume = minVolume;
	}

	if (Object.keys(errors).length > 0) {
		return new Response(JSON.stringify({ errors }), { status: 422 });
	}

	// UTM params are optional (organic traffic won't have them), but sanitize whatever arrives.
	const utmData: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
	for (const key of UTM_KEYS) {
		const raw = body[key];
		const value = typeof raw === 'string' ? raw.trim() : '';
		if (value && UTM_VALUE_REGEX.test(value)) {
			utmData[key] = value;
		}
	}

	const landingPageUrl = request.headers.get('referer') || new URL(request.url).origin + '/';

	const utmRows = UTM_KEYS.filter((key) => utmData[key]).map(
		(key) => `<p><strong>${UTM_LABELS[key]}:</strong> ${escapeHtml(utmData[key]!)}</p>`
	);
	const utmSection = utmRows.length
		? `<hr />\n\t\t<p><strong>Datos de campaña</strong></p>\n\t\t${utmRows.join('\n\t\t')}`
		: '';

	const htmlContent = `
		<h2>Nueva solicitud de cotización</h2>
		<p>Se ha recibido desde la Landing Page de Suministro continuo de combustible para transporte, flotillas y sector industrial.</p>
		<p><strong>Nombre:</strong> ${escapeHtml(clean.fullName)}</p>
		<p><strong>Correo:</strong> ${escapeHtml(clean.corporateEmail)}</p>
		<p><strong>Teléfono:</strong> ${escapeHtml(clean.businessPhone)}</p>
		<p><strong>Empresa:</strong> ${escapeHtml(clean.companyName)}</p>
		<p><strong>Ciudad de operación:</strong> ${escapeHtml(clean.operationCity)}</p>
		<p><strong>Tipo de energético:</strong> ${escapeHtml(clean.energyType)}</p>
		<p><strong>Consumo &ge; 5,000 L por pedido:</strong> ${escapeHtml(clean.minVolume)}</p>
		${utmSection}
		<hr />
		<p>Este mensaje fue enviado automáticamente desde: ${escapeHtml(landingPageUrl)}</p>
	`;

	try {
		const brevoResponse = await fetch(BREVO_API_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'api-key': import.meta.env.BREVO_API_KEY,
			},
			body: JSON.stringify({
				sender: { email: SENDER_EMAIL, name: 'Energex - Suministro continuo de combustible' },
				to: RECIPIENT_EMAILS.map((email) => ({ email })),
				replyTo: { email: clean.corporateEmail, name: clean.fullName },
				subject: `Nueva solicitud de cotización - ${clean.fullName}`,
				htmlContent,
			}),
		});

		if (!brevoResponse.ok) {
			const errorBody = await brevoResponse.text();
			console.error('Brevo API error:', brevoResponse.status, errorBody);
			return new Response(
				JSON.stringify({ error: 'No se pudo enviar la solicitud. Intenta de nuevo.' }),
				{ status: 502 }
			);
		}
	} catch (err) {
		console.error('Brevo request failed:', err);
		return new Response(
			JSON.stringify({ error: 'No se pudo enviar la solicitud. Intenta de nuevo.' }),
			{ status: 502 }
		);
	}

	// n8n webhook (testing): best-effort, doesn't block the user-facing response.
	try {
		await fetch(N8N_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...clean,
				...utmData,
				landingPageUrl,
				submittedAt: new Date().toISOString(),
			}),
		});
	} catch (err) {
		console.error('n8n webhook request failed:', err);
	}

	return new Response(JSON.stringify({ success: true }), { status: 200 });
};
