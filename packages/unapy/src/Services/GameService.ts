import CardService from "@/Services/CardService"
import SocketService from "@/Services/SocketService"
import PlayerService from "@/Services/PlayerService"
import GameRoundService from "@/Services/GameRoundService"
import ClientService from "@/Services/ClientService"

import NumberUtil from "@/Utils/NumberUtil"
import ArrayUtil from "@/Utils/ArrayUtil"

import environmentConfig from "@/Config/environment"

import {
	Game,
	GameEvents,
	PlayerData,
	CurrentPlayerInfo,
	CurrentPlayerGameStatus,
	CardData,
	CardColors,
	PlayerStatus,
} from "@uno-game/protocols"

import GameRepository from "@/Repositories/GameRepository"

class GameService {
	async setupGame (playerId: string, gameId: string, chatId: string): Promise<void> {
		const cards = await CardService.setupRandomCards()

		const playerData = await PlayerService.getPlayerData(playerId)

		const initialPlayer: PlayerData = {
			id: playerId,
			name: playerData.name,
			handCards: [],
			status: "online",
			ready: false,
			isCurrentRoundPlayer: false,
			canBuyCard: false,
		}

		const game: Game = {
			maxPlayers: 6,
			type: "public",
			status: "waiting",
			round: 0,
			id: gameId,
			chatId,
			currentPlayerIndex: 0,
			nextPlayerIndex: 1,
			currentGameColor: null,
			title: playerData.name,
			availableCards: [],
			usedCards: [],
			players: [initialPlayer],
			cards,
			direction: "clockwise",
			currentCardCombo: {
				cardTypes: [],
				amountToBuy: 0,
			},
			maxRoundDurationInSeconds: environmentConfig.isDev ? 200000 : 30,
			createdAt: Date.now(),
		}

		await this.setGameData(gameId, game)

		this.emitGameEvent(gameId, "GameCreated", game)
	}

	async getExistingPlayerGame (playerId: string): Promise<Game> {
		const player = await PlayerService.getPlayerData(playerId)
		const games = await this.getGameList()

		const game = games
			.filter(({ status }) => status === "waiting")
			.find(({ title }) => title === player.name)

		return game
	}

	async getChatIdByGameId (gameId: string): Promise<string> {
		const game = await GameRepository.getGame(gameId)

		return game?.chatId
	}

	async gameExists (gameId: string): Promise<boolean> {
		const game = await GameRepository.getGame(gameId)

		if (game) {
			return true
		} else {
			return false
		}
	}

	async joinGame (gameId: string, playerId: string): Promise<void> {
		const game = await this.getGame(gameId)

		const player = game?.players?.find(player => player.id === playerId)

		const gameHasNotStarted = game.status === "waiting"
		const gameIsNotFull = game.players.length < game.maxPlayers
		const playerIsNotOnGame = !player

		if (gameHasNotStarted && gameIsNotFull && playerIsNotOnGame) {
			this.addPlayer(gameId, playerId)
		}

		const gameRoundRemainingTimeInSeconds = await this.getRoundRemainingTimeInSeconds(gameId)

		GameRoundService.emitGameRoundEvent(gameId, "GameRoundRemainingTimeChanged", gameRoundRemainingTimeInSeconds)

		if (!playerIsNotOnGame) {
			game.players = await this.buildPlayersWithChangedPlayerStatus(gameId, playerId, "online")
		}

		this.emitGameEvent(gameId, "PlayerJoined", game)
	}

	async purgePlayer (playerId: string): Promise<void> {
		const games = await this.getGameList()

		await Promise.all(
			games.map(async game => {
				const isPlayerOnGame = game?.players?.find(player => player?.id === playerId)

				if (isPlayerOnGame) {
					await this.disconnectPlayer(game?.id, playerId)

					this.emitGameEvent(game?.id, "PlayerLeft", game)
				}
			}),
		)
	}

	async toggleReady (playerId: string, gameId: string): Promise<void> {
		const game = await this.getGame(gameId)

		game.players = game?.players?.map(player => {
			if (player.id === playerId) {
				return {
					...player,
					ready: !player.ready,
				}
			} else {
				return player
			}
		})

		await this.setGameData(gameId, game)

		const areAllPlayersReady = game?.players?.every(player => player.ready)

		if (areAllPlayersReady) {
			await this.startGame(gameId)
		}
	}

	async getGameList (): Promise<Game[]> {
		return await GameRepository.getGameList()
	}

	async buyCard (playerId: string, gameId: string): Promise<void> {
		const currentPlayerInfo = await this.getCurrentPlayerInfo(gameId)

		if (currentPlayerInfo.id !== playerId) {
			return
		}

		const game = await this.getGame(gameId)

		const player = game?.players?.find(player => player.id === currentPlayerInfo.id)

		const needToBuyCard = player?.handCards?.every(card => !card.canBeUsed)

		if (!needToBuyCard) {
			return
		}

		const available = [...game?.availableCards]

		const card = available.shift()

		game.players = game?.players?.map(player => {
			if (player.id === playerId) {
				return {
					...player,
					handCards: [card, ...player?.handCards],
				}
			} else {
				return player
			}
		})

		game.availableCards = available

		await this.setGameData(gameId, game)

		game.players = await this.buildPlayersWithCardUsability(currentPlayerInfo.id, gameId)

		await this.setGameData(gameId, game)
	}

	async putCard (playerId: string, cardIds: string[], gameId: string, selectedColor: CardColors): Promise<void> {
		const currentPlayerInfo = await this.getCurrentPlayerInfo(gameId)

		if (currentPlayerInfo.id !== playerId) {
			return
		}

		let game = await this.getGame(gameId)

		const player = game?.players?.find(player => player.id === playerId)

		const cards: CardData[] = []

		cardIds.forEach(cardId => {
			const card = player?.handCards?.find(card => card.id === cardId)

			cards.push(card)
		})

		game.players = game?.players?.map(player => {
			if (player.id === playerId) {
				return {
					...player,
					handCards: player?.handCards?.filter(card => !cardIds.includes(card.id)),
				}
			} else {
				return player
			}
		})

		/**
		 * We keep flowing the used cards back to stack, in order to help
		 * keeping the game up till someone wins it.
		 */
		const usedCards = [...cards, ...game?.usedCards]

		const inStackCards = usedCards.slice(0, 10)
		let outStackCards = usedCards.slice(10, usedCards.length)

		outStackCards = outStackCards.map(card => {
			if (card.color === "black") {
				return {
					...card,
					selectedColor: null,
					src: card.possibleColors.black,
				}
			} else {
				return card
			}
		})

		ArrayUtil.shuffle(outStackCards)

		game.usedCards = inStackCards
		game.availableCards = [
			...game.availableCards,
			...outStackCards,
		]

		game.currentGameColor = cards[0]?.color

		await this.setGameData(gameId, game)

		game = await this.buildGameWithCardEffect(gameId, cards, selectedColor)

		await this.setGameData(gameId, game)

		await this.nextRound(gameId)
	}

	async changePlayerStatus (gameId: string, playerId: string, playerStatus: PlayerStatus): Promise<void> {
		const game = await this.getGame(gameId)

		game.players = await this.buildPlayersWithChangedPlayerStatus(gameId, playerId, playerStatus)

		await this.setGameData(gameId, game)
	}

	emitGameEvent (gameId: string, event: GameEvents, ...data: unknown[]) {
		SocketService.emitRoomEvent(gameId, event, ...data)

		const gameUpdateEvents: GameEvents[] = [
			"GameStarted",
			"GameCreated",
			"GameEnded",
			"PlayerJoined",
			"PlayerLeft",
		]

		const isGameUpdateEvent = gameUpdateEvents.some(gameEvent => gameEvent === event)

		if (isGameUpdateEvent) {
			ClientService.dispatchGameHistoryConsolidated()
			ClientService.dispatchGameListUpdated()
		}
	}

	private async makeComputedPlay (gameId: string, playerId: string): Promise<void> {
		const game = await this.getGame(gameId)

		const player = game.players.find(playerItem => playerItem.id === playerId)

		if (player.status === "online") {
			return
		}

		const { handCards } = player

		const usableCard = handCards.find(card => card.canBeUsed)

		if (!usableCard) {
			await this.buyCard(playerId, gameId)

			return await this.makeComputedPlay(gameId, playerId)
		}

		const randomCardColor = await CardService.retrieveRandomCardColor()

		this.putCard(playerId, [usableCard.id], gameId, randomCardColor)
	}

	private async getRoundRemainingTimeInSeconds (gameId: string): Promise<number> {
		const remainingTimeInSeconds = await GameRoundService.getRoundRemainingTimeInSeconds(gameId)

		return remainingTimeInSeconds
	}

	private async resetRoundCounter (gameId: string): Promise<void> {
		const game = await this.getGame(gameId)

		const gameRoundRemainingTime = await this.getRoundRemainingTimeInSeconds(gameId)

		GameRoundService.emitGameRoundEvent(gameId, "GameRoundRemainingTimeChanged", gameRoundRemainingTime)

		GameRoundService.resetRoundCounter(gameId, {
			timeoutAction: async (gameId) => {
				const currentPlayerInfo = await this.getCurrentPlayerInfo(gameId)

				game.players = await this.buildPlayersWithChangedPlayerStatus(gameId, currentPlayerInfo.id, "afk")

				await this.setGameData(gameId, game)

				await this.makeComputedPlay(gameId, currentPlayerInfo.id)

				this.emitGameEvent(gameId, "PlayerGotAwayFromKeyboard", currentPlayerInfo.id)
			},
			intervalAction: async (gameId) => {
				const gameRoundRemainingTime = await this.getRoundRemainingTimeInSeconds(gameId)

				GameRoundService.emitGameRoundEvent(gameId, "GameRoundRemainingTimeChanged", gameRoundRemainingTime)
			},
			gameId,
			timeInSeconds: game.maxRoundDurationInSeconds,
		})
	}

	private async removeRoundCounter (gameId: string): Promise<void> {
		await GameRoundService.removeRoundCounter(gameId)
	}

	private async buildPlayersWithChangedPlayerStatus (gameId: string, playerId: string, status: PlayerStatus): Promise<PlayerData[]> {
		const game = await this.getGame(gameId)

		const playersWithChangedPlayerStatus = game.players.map(player => {
			if (player.id === playerId) {
				return {
					...player,
					status,
				}
			}

			return player
		})

		return playersWithChangedPlayerStatus
	}

	private async startGame (gameId: string): Promise<void> {
		const game = await this.getGame(gameId)

		const allCards = [...game?.cards]

		const currentPlayer = game?.players?.[game.currentPlayerIndex]

		game.status = "playing"

		game.players = game?.players.map(player => {
			const handCards: CardData[] = []

			for (let i = 0; i < 7; i++) {
				const selectedCard = allCards.shift()
				handCards.push(selectedCard)
			}

			return {
				...player,
				isCurrentRoundPlayer: player.id === currentPlayer.id,
				handCards: handCards.map(handCard => ({
					...handCard,
					canBeUsed: player.id === currentPlayer.id,
				})),
				canBuyCard: false,
			}
		})

		game.availableCards = allCards

		await this.setGameData(gameId, game)

		this.emitGameEvent(gameId, "GameStarted", game)

		await	this.resetRoundCounter(gameId)
	}

	private async addPlayer (gameId: string, playerId: string): Promise<void> {
		const game = await this.getGame(gameId)

		const playerData = await PlayerService.getPlayerData(playerId)

		game.players = [
			...game?.players,
			{
				id: playerId,
				name: playerData.name,
				handCards: [],
				status: "online",
				ready: false,
				isCurrentRoundPlayer: false,
				canBuyCard: false,
			},
		]

		await this.setGameData(gameId, game)
	}

	private async disconnectPlayer (gameId: string, playerId: string): Promise<void> {
		const game = await this.getGame(gameId)

		if (game.status === "waiting") {
			game.players = game?.players?.filter(player => player.id !== playerId)
		}

		if (game.status === "playing") {
			game.players = await this.buildPlayersWithChangedPlayerStatus(gameId, playerId, "offline")
		}

		await this.setGameData(gameId, game)
	}

	private async getGame (gameId: string): Promise<Game> {
		const game = await GameRepository.getGame(gameId)

		return game
	}

	private async nextRound (gameId: string): Promise<void> {
		await this.resetRoundCounter(gameId)

		const currentPlayerInfo = await this.getCurrentPlayerInfo(gameId)

		if (currentPlayerInfo.gameStatus === "winner") {
			this.emitGameEvent(gameId, "PlayerWon", currentPlayerInfo.id, currentPlayerInfo.name)
			return this.endGame(gameId)
		}

		if (currentPlayerInfo.gameStatus === "uno") {
			this.emitGameEvent(gameId, "PlayerUno", currentPlayerInfo.id)
		}

		const game = await this.getGame(gameId)

		const expectedNextPlayerIndex = game?.nextPlayerIndex

		const nextPlayerIndex = NumberUtil.getSanitizedValueWithBoundaries(expectedNextPlayerIndex, game?.players?.length, 0)

		if (game.direction === "clockwise") {
			game.nextPlayerIndex = nextPlayerIndex + 1
		} else {
			game.nextPlayerIndex = nextPlayerIndex - 1
		}

		const nextPlayer = game?.players?.[nextPlayerIndex]

		game.players = await this.buildPlayersWithCardUsability(nextPlayer.id, gameId)

		game.round++

		game.currentPlayerIndex = nextPlayerIndex

		await this.setGameData(gameId, game)

		const nextPlayerInfo = await this.getCurrentPlayerInfo(gameId)

		if (nextPlayerInfo.playerStatus === "afk") {
			setTimeout(() => {
				this.makeComputedPlay(gameId, nextPlayerInfo.id)
			}, 1000)
		}
	}

	private async setGameData (gameId: string, game: Game): Promise<void> {
		await GameRepository.setGameData(gameId, game)

		this.emitGameEvent(gameId, "GameStateChanged", game)
	}

	private async getTopStackCard (gameId: string): Promise<CardData> {
		const game = await this.getGame(gameId)

		return game?.usedCards?.[0]
	}

	private cardCanBeBuyCombed = (game: Game, card: CardData): boolean => {
		const currentCardComboType = game?.currentCardCombo?.cardTypes?.[0]

		return (
			(card.type === "buy-2" && currentCardComboType === "buy-4" && card.color === game.currentGameColor) ||
			(card.type === "buy-2" && currentCardComboType === "buy-2") ||
			(card.type === "buy-4")
		)
	}

	private async buildGameWithCardEffect (gameId: string, cards: CardData[], selectedColor: CardColors): Promise<Game> {
		const cardTypes = cards.map(card => card.type)
		const cardIds = cards.map(card => card.id)

		const game = await this.getGame(gameId)

		let playerAffected: PlayerData

		const isBuy4Card = cardTypes.every(cardType => cardType === "buy-4")
		const isBuy2Card = cardTypes.every(cardType => cardType === "buy-2")
		const isChangeColorCard = cardTypes.every(cardType => cardType === "change-color")
		const isReverseCard = cardTypes.every(cardType => cardType === "reverse")
		const isBlockCard = cardTypes.every(cardType => cardType === "block")

		if (isChangeColorCard || isBuy4Card) {
			game.currentGameColor = selectedColor

			game.usedCards = game.usedCards.map(card => {
				if (cardIds.includes(card.id)) {
					return {
						...card,
						selectedColor,
						src: card.possibleColors[selectedColor],
					}
				} else {
					return card
				}
			})
		}

		if (isReverseCard) {
			if (cardTypes.length % 2 === 0) {
				game.nextPlayerIndex = game.currentPlayerIndex
			} else if (game.direction === "clockwise") {
				game.direction = "counterclockwise"

				game.nextPlayerIndex = game.currentPlayerIndex - 1
			} else {
				game.direction = "clockwise"

				game.nextPlayerIndex = game.currentPlayerIndex + 1
			}
		}

		if (isBlockCard) {
			cardTypes.forEach(() => {
				const nextPlayerIndex = NumberUtil.getSanitizedValueWithBoundaries(game?.nextPlayerIndex, game?.players?.length, 0)
				playerAffected = game?.players?.[nextPlayerIndex]

				if (game.direction === "clockwise") {
					game.nextPlayerIndex++
				} else {
					game.nextPlayerIndex--
				}

				this.emitGameEvent(game.id, "PlayerBlocked", playerAffected?.id)
			})
		}

		if (isBuy2Card || isBuy4Card) {
			game.currentCardCombo.cardTypes = [
				...game.currentCardCombo.cardTypes,
				...cardTypes,
			]

			const nextPlayerIndex = NumberUtil.getSanitizedValueWithBoundaries(game?.nextPlayerIndex, game?.players?.length, 0)
			playerAffected = game?.players?.[nextPlayerIndex]

			const affectedPlayerCanMakeCardBuyCombo = playerAffected.handCards
				.some(card => this.cardCanBeBuyCombed(game, card))

			game.currentCardCombo.amountToBuy = 0

			game.currentCardCombo.cardTypes.forEach(cardType => {
				if (cardType === "buy-2") {
					game.currentCardCombo.amountToBuy += 2
				} else if (cardType === "buy-4") {
					game.currentCardCombo.amountToBuy += 4
				}
			})

			if (!affectedPlayerCanMakeCardBuyCombo) {
				this.emitGameEvent(game.id, "PlayerBuyCards", playerAffected?.id, game.currentCardCombo.amountToBuy)

				let available = [...game?.availableCards]

				const cards = available.slice(0, game.currentCardCombo.amountToBuy)

				available = available.slice(game.currentCardCombo.amountToBuy, available.length)

				game.players = game?.players?.map(player => {
					if (player.id === playerAffected.id) {
						return {
							...player,
							handCards: [...cards, ...player?.handCards],
						}
					} else {
						return player
					}
				})

				game.availableCards = available

				game.currentCardCombo = {
					cardTypes: [],
					amountToBuy: 0,
				}

				if (game.direction === "clockwise") {
					game.nextPlayerIndex++
				} else {
					game.nextPlayerIndex--
				}
			}
		}

		return game
	}

	private async buildPlayersWithCardUsability (currentPlayerId: string, gameId: string): Promise<PlayerData[]> {
		const game = await this.getGame(gameId)

		const topStackCard = await this.getTopStackCard(gameId)

		const playersWithCardUsability = game?.players?.map(player => {
			if (currentPlayerId === player.id) {
				const handCards = player?.handCards?.map(handCard => ({
					...handCard,
					canBeUsed: game?.currentCardCombo?.cardTypes.length ? (
						this.cardCanBeBuyCombed(game, handCard)
					) : (
						topStackCard?.color === handCard?.color ||
						handCard?.type === "change-color" ||
						handCard?.type === "buy-4" ||
						topStackCard?.type === handCard?.type ||
						handCard?.color === game.currentGameColor
					),
					canBeCombed: game.currentCardCombo.cardTypes.includes(handCard?.type),
				}))

				return {
					...player,
					isCurrentRoundPlayer: true,
					canBuyCard: handCards.every(card => !card.canBeUsed),
					handCards,
				}
			} else {
				return {
					...player,
					isCurrentRoundPlayer: false,
					canBuyCard: false,
					handCards: player?.handCards?.map(handCard => ({
						...handCard,
						canBeUsed: false,
						canBeCombed: false,
					})),
				}
			}
		})

		return playersWithCardUsability
	}

	private async getCurrentPlayerInfo (gameId: string): Promise<CurrentPlayerInfo> {
		const game = await this.getGame(gameId)

		const { players } = game

		const currentPlayer = players[game?.currentPlayerIndex]

		const currentPlayerId = currentPlayer?.id
		let gameStatus: CurrentPlayerGameStatus

		/**
		 * In case the current player has no card on hand, he's the winner
		 */
		if (currentPlayer?.handCards.length === 0) {
			gameStatus = "winner"
		/**
		 * In case the player has only one card, he's made uno
		 */
		} else if (currentPlayer?.handCards.length === 1) {
			gameStatus = "uno"
		}

		return {
			id: currentPlayerId,
			name: currentPlayer.name,
			playerStatus: currentPlayer.status,
			gameStatus,
		}
	}

	private async endGame (gameId: string): Promise<void> {
		const winnerInfo = await this.getCurrentPlayerInfo(gameId)

		const game = await this.getGame(gameId)

		const cards = await CardService.setupRandomCards()

		game.status = "ended"

		game.round = 0

		const winnerIndex = game.players.findIndex(player => player.id === winnerInfo.id)

		game.currentPlayerIndex = winnerIndex

		game.nextPlayerIndex = NumberUtil.getSanitizedValueWithBoundaries(game?.currentPlayerIndex + 1, game?.players?.length, 0)

		game.availableCards = []

		game.usedCards = []

		game.currentCardCombo = {
			cardTypes: [],
			amountToBuy: 0,
		}

		game.cards = cards

		game.players = game?.players?.map(player => ({
			...player,
			canBuyCard: false,
			handCards: [],
			isCurrentRoundPlayer: false,
			ready: false,
			status: "online",
			usedCards: [],
		}))

		await this.setGameData(gameId, game)

		await this.removeRoundCounter(gameId)

		this.emitGameEvent(gameId, "GameEnded")
	}
}

export default new GameService()
